import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { HostBridge, PcmData, ThumbnailStrip, WaveformData } from '../shared/ipc'
import type { MediaMeta } from '../shared/project'
import { flicksToSeconds, parseFrameRate, secondsToFlicks } from '../shared/time'
import { capture, getFFmpegTools, spawnTracked } from './ffmpeg'
import { PeakBuilder, thumbnailInterval } from './media-utils'
import { mediaUrl } from './protocols'

interface ProbeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number
  avg_frame_rate?: string; r_frame_rate?: string; duration?: string; nb_frames?: string
  disposition?: { attached_pic?: number }
}
interface ProbeResult { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } }
type Meta = MediaMeta & { error?: string }
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.svg'])
const exists = async (path: string): Promise<boolean> => { try { return (await stat(path)).isFile() } catch { return false } }
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function parseProbe(data: ProbeResult, path: string, size: number): MediaMeta {
  const video = data.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = data.streams?.find((s) => s.codec_type === 'audio')
  const meta: MediaMeta = { size, hasVideo: !!video, hasAudio: !!audio }
  if (video) {
    meta.width = video.width
    meta.height = video.height
    meta.videoCodec = video.codec_name
    const [num, den = '1'] = ((video.avg_frame_rate === '0/0' ? video.r_frame_rate : video.avg_frame_rate ?? video.r_frame_rate) ?? '0').split('/')
    const fps = Number(num) / Number(den)
    if (Number.isFinite(fps) && fps > 0) meta.fps = parseFrameRate(fps)
  }
  if (audio) meta.audioCodec = audio.codec_name
  const still = video && !audio && (video.nb_frames === '1' || imageExtensions.has(extname(path).toLowerCase()) && !(Number(video.nb_frames) > 1))
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration)
  if (!still && Number.isFinite(duration) && duration >= 0) meta.duration = secondsToFlicks(duration)
  return meta
}

function parseFFmpegProbe(text: string, path: string, size: number): MediaMeta {
  const video = text.match(/Stream[^\n]*Video:\s*(\w+)[^\n]*/)?.[0]
  const audio = text.match(/Stream[^\n]*Audio:\s*(\w+)[^\n]*/)?.[0]
  const dimensions = video?.match(/\b(\d{2,6})x(\d{2,6})\b/)
  const fps = video?.match(/([\d.]+)\s+fps/)
  const duration = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
  return parseProbe({
    streams: [
      ...(video ? [{ codec_type: 'video', codec_name: video.match(/Video:\s*(\w+)/)?.[1], width: dimensions ? +dimensions[1] : undefined, height: dimensions ? +dimensions[2] : undefined, avg_frame_rate: fps?.[1] }] : []),
      ...(audio ? [{ codec_type: 'audio', codec_name: audio.match(/Audio:\s*(\w+)/)?.[1] }] : [])
    ],
    format: { duration: duration ? String(+duration[1] * 3600 + +duration[2] * 60 + +duration[3]) : undefined }
  }, path, size)
}

/** No Electron dependency: services can also be exercised by a plain Bun/Node harness. */
export function createMediaService(cacheRoot: string): HostBridge['media'] {
  const probes = new Map<string, Promise<Meta>>()
  const jobs = new Map<string, Promise<unknown>>()
  const failedThumbnails = new Set<string>()
  let runningThumbnails = 0
  const thumbnailQueue: (() => void)[] = []

  async function source(path: string): Promise<{ key: string; dir: string; size: number }> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Media path is not a file')
    const key = createHash('sha1').update(`${path}\0${info.size}\0${info.mtimeMs}`).digest('hex')
    return { key, dir: join(cacheRoot, key), size: info.size }
  }

  async function probe(path: string): Promise<Meta> {
    try {
      const info = await source(path)
      let pending = probes.get(info.key)
      if (!pending) {
        pending = (async () => {
          const tools = await getFFmpegTools()
          if (tools.ffprobe) {
            const result = await capture(tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], 30_000)
            if (result.code === 0) return parseProbe(JSON.parse(result.stdout) as ProbeResult, path, info.size)
            throw new Error(result.stderr.trim() || 'Unable to probe media')
          }
          const result = await capture(tools.ffmpeg, ['-hide_banner', '-i', path], 30_000)
          const meta = parseFFmpegProbe(result.stderr, path, info.size)
          if (!meta.hasVideo && !meta.hasAudio) throw new Error(result.stderr.trim() || 'Unable to probe media')
          return meta
        })()
        probes.set(info.key, pending)
        // Do not retain failures: files may be temporarily locked or still being written.
        void pending.catch(() => probes.delete(info.key))
      }
      return await pending
    } catch (error) { return { error: errorMessage(error) } }
  }

  async function encode(args: string[]): Promise<void> {
    const { ffmpeg } = await getFFmpegTools()
    const result = await capture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args])
    if (result.code !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited with ${result.code}`)
  }

  function once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = jobs.get(key)
    if (existing) return existing as Promise<T>
    const pending = work().finally(() => jobs.delete(key))
    jobs.set(key, pending)
    return pending
  }

  function queueThumbnails(work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = (): void => {
        runningThumbnails++
        void work().then(resolve, reject).finally(() => {
          runningThumbnails--
          thumbnailQueue.shift()?.()
        })
      }
      if (runningThumbnails < 2) start()
      else thumbnailQueue.push(start)
    })
  }

  async function thumbnails(path: string, opts?: { height?: number }): Promise<ThumbnailStrip | null> {
    try {
      const [info, meta] = await Promise.all([source(path), probe(path)])
      if (meta.error || !meta.hasVideo) return null
      const height = Math.round(Math.max(16, Math.min(1080, opts?.height || 72)))
      const dir = join(info.dir, `thumbs-${height}`)
      await mkdir(dir, { recursive: true })
      const duration = meta.duration ? flicksToSeconds(meta.duration) : 0
      const interval = thumbnailInterval(duration)
      const expectedCount = Math.max(1, Math.ceil(duration / interval))
      const width = Math.max(2, Math.round((meta.width ?? 16) / (meta.height ?? 9) * height / 2) * 2)
      const base: ThumbnailStrip = {
        urlPattern: mediaUrl(join(dir, 'thumb_{i}.jpg')).replace('%7Bi%7D', '{i}'),
        interval, count: 0, width, height, partial: true
      }
      const manifest = join(dir, 'manifest.json')
      try {
        const cached = JSON.parse(await readFile(manifest, 'utf8')) as ThumbnailStrip
        if (!cached.partial && cached.count > 0 && await exists(join(dir, `thumb_${cached.count - 1}.jpg`))) return { ...base, count: cached.count, partial: false }
      } catch { /* Cache is absent or interrupted. */ }
      const files = new Set(await readdir(dir))
      while (files.has(`thumb_${base.count}.jpg`)) base.count++
      if (failedThumbnails.has(dir)) return base.count ? { ...base, partial: false } : null
      if (!jobs.has(dir)) {
        const pending = once(dir, () => queueThumbnails(async () => {
          await encode(['-threads', '2', '-skip_frame', 'nokey', '-i', path, '-an',
            '-vf', `scale=${width}:${height},fps=fps=1/${interval}:start_time=0:round=near:eof_action=pass,tpad=stop_mode=clone:stop_duration=${duration || interval}`,
            '-frames:v', String(expectedCount), '-q:v', '5', '-start_number', '0', '-atomic_writing', '1', join(dir, 'thumb_%d.jpg')])
          const generated = new Set(await readdir(dir))
          let count = 0
          while (generated.has(`thumb_${count}.jpg`)) count++
          if (!count) throw new Error('ffmpeg produced no thumbnail frames')
          await writeFile(manifest, JSON.stringify({ ...base, count, partial: false }))
        }))
        void pending.catch((error: unknown) => {
          failedThumbnails.add(dir)
          console.warn('Thumbnail generation failed:', path, errorMessage(error))
        })
      }
      return base
    } catch (error) { console.warn('Unable to load thumbnails:', errorMessage(error)); return null }
  }

  async function waveform(path: string): Promise<WaveformData | null> {
    try {
      const [info, meta] = await Promise.all([source(path), probe(path)])
      if (meta.error || !meta.hasAudio) return null
      const output = join(info.dir, 'peaks.f32')
      const data = async (): Promise<WaveformData> => ({ rate: 200, url: mediaUrl(output), length: (await stat(output)).size / 8 })
      if (await exists(output)) return await data()
      return await once(output, async () => {
        await mkdir(info.dir, { recursive: true })
        const temporary = `${output}.partial`
        const file = await open(temporary, 'w')
        const peaks = new PeakBuilder()
        let child: ReturnType<typeof spawnTracked> | undefined
        try {
          const { ffmpeg } = await getFFmpegTools()
          child = spawnTracked(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'])
          let stderr = ''
          child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000) })
          const finished = new Promise<void>((resolve, reject) => {
            child!.once('error', reject)
            child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited with ${code}`)))
          })
          // Attach rejection handling immediately, while stdout is being consumed.
          void finished.catch(() => {})
          for await (const chunk of child.stdout!) {
            const buffer = peaks.push(chunk as Buffer)
            if (buffer.length) await file.writeFile(buffer)
          }
          await finished
          const last = peaks.finish()
          if (last.length) await file.writeFile(last)
          await file.close()
          await rename(temporary, output)
          return await data()
        } catch (error) {
          child?.kill('SIGKILL')
          await file.close().catch(() => {})
          await unlink(temporary).catch(() => {})
          throw error
        }
      })
    } catch (error) { console.warn('Waveform generation failed:', errorMessage(error)); return null }
  }

  async function pcm(path: string, startSec: number, durationSec: number, sampleRate = 48000): Promise<PcmData | null> {
    try {
      const info = await source(path)
      const start = Math.max(0, Number(startSec) || 0)
      const duration = Math.min(600, Math.max(0, Number(durationSec) || 0))
      const rate = Math.round(Math.min(192000, Math.max(8000, sampleRate)))
      if (!duration) return null
      const output = join(info.dir, `pcm-${start.toFixed(4)}-${duration.toFixed(4)}-${rate}.f32`)
      const data = async (): Promise<PcmData> => ({ url: mediaUrl(output), sampleRate: rate, channels: 2, frames: (await stat(output)).size / 8 })
      if (await exists(output)) return await data()
      return await once(output, async () => {
        await mkdir(info.dir, { recursive: true })
        const temporary = `${output}.partial`
        // Input seeking: fast on long sources; a codec-priming packet of offset is fine here.
        await encode(['-ss', String(start), '-i', path, '-t', String(duration), '-vn', '-ac', '2', '-ar', String(rate), '-c:a', 'pcm_f32le', '-f', 'f32le', temporary])
        await rename(temporary, output)
        return await data()
      })
    } catch (error) { console.warn('PCM decode failed:', errorMessage(error)); return null }
  }

  async function poster(path: string, atSeconds = 0): Promise<string | null> {
    try {
      const info = await source(path)
      const time = Number.isFinite(atSeconds) ? Math.max(0, atSeconds) : 0
      const output = join(info.dir, `poster-${time}.jpg`)
      if (await exists(output)) return mediaUrl(output)
      return await once(output, async () => {
        await mkdir(info.dir, { recursive: true })
        const temporary = `${output}.partial.jpg`
        await encode(['-ss', String(time), '-i', path, '-an', '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '3', temporary])
        if (!await exists(temporary)) return null
        await rename(temporary, output)
        return mediaUrl(output)
      })
    } catch (error) { console.warn('Poster generation failed:', errorMessage(error)); return null }
  }

  async function proxy(path: string): Promise<string | null> {
    try {
      const info = await source(path)
      const output = join(info.dir, 'proxy.mp4')
      if (await exists(output)) return output
      return await once(output, async () => {
        await mkdir(info.dir, { recursive: true })
        const temporary = join(info.dir, 'proxy.partial.mp4')
        await encode(['-i', path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', temporary])
        await rename(temporary, output)
        return output
      })
    } catch (error) { console.warn('Proxy generation failed:', errorMessage(error)); return null }
  }

  return { probe, thumbnails, waveform, pcm, proxy, poster }
}
