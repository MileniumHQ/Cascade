import { app, clipboard, ClipboardItem, ipcMain, nativeImage, type NativeImage, type WebContents } from 'electron'
import { availableParallelism, tmpdir } from 'node:os'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExportProgress, ExportRequest, FFmpegExportPlan, FrameRequest, HostBridge, RenderWorkerJob } from '../../shared/ipc'
import { FLICKS, frameToFlicks } from '../../shared/time'
import { getFFmpegTools } from '../ffmpeg'
import { partitionFrames, validateRequest } from './plan'
import { ExportScope, writeFrame } from './process'
import { registerWorkerIpc, RenderWorker } from './worker'
import { renderAudio } from './audio'

interface Job {
  id: string; req: ExportRequest; owner: WebContents; scope: ExportScope
  total: number; done: number; stale: number; workers: number; started: number; lastProgress: number
  cancelled: boolean; finished?: Promise<void>; ownerGone?: () => void
}
const jobs = new Map<string, Job>()
let warm: RenderWorker | undefined
let warmTimer: ReturnType<typeof setTimeout> | undefined
let stillChain: Promise<unknown> = Promise.resolve()
let stillIndex = 0
let quitting = false
let readyToQuit = false

function emit(job: Job, state: ExportProgress['state'], message?: string, force = true) {
  if (!force && Date.now() - job.lastProgress < 250) return
  job.lastProgress = Date.now()
  const seconds = Math.max(0.001, (Date.now() - job.started) / 1000)
  const fps = job.done / seconds
  if (!job.owner.isDestroyed()) job.owner.send('export:progress', {
    jobId: job.id, state, framesDone: job.done, framesTotal: job.total, fps,
    etaSeconds: fps > 0 ? Math.max(0, (job.total - job.done) / fps) : undefined,
    output: job.req.output, message, stalePaints: job.stale, workers: job.workers
  } satisfies ExportProgress)
}

function workerJob(req: ExportRequest, mode: RenderWorkerJob['mode'] = 'video'): RenderWorkerJob {
  return { project: req.project, timelineId: req.timelineId, width: req.width, height: req.height, fps: req.fps, mode, stampHeight: 8 }
}

async function segments(job: Job, ffmpeg: string, directory: string, plan: FFmpegExportPlan): Promise<string[]> {
  const scope = job.scope.child()
  const req = job.req
  const parts = partitionFrames(job.total, job.workers)
  const threads = Math.max(1, Math.floor(availableParallelism() / parts.length))
  const pending = parts.map(async (part, i) => {
    const sequence = plan.kind === 'sequence'
    const path = sequence ? join(directory, 'sequence', 'frame-%08d.png') : join(directory, `segment-${i}.${plan.twoPass ? 'mkv' : plan.extension}`)
    if (sequence) await mkdir(dirname(path), { recursive: true })
    scope.check()
    const encoder = scope.start(ffmpeg, [
      ...(plan.inputArgs ?? []), '-filter_threads', '1',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${req.width}x${req.height}`, '-r', `${req.fps.num}/${req.fps.den}`, '-i', 'pipe:0',
      '-an', '-threads', String(threads), ...plan.videoArgs,
      '-frames:v', String(part.end - part.start),
      ...(plan.container === 'mp4' || plan.container === 'mov' ? ['-video_track_timescale', String(req.fps.num)] : []),
      ...(plan.segmentContainer ?? plan.container ? ['-f', (plan.segmentContainer ?? plan.container)!] : []), path
    ])
    const worker = scope.worker(workerJob(req))
    void encoder.done.catch(error => worker.fail(error))
    try {
      for (let frame = part.start; frame < part.end; frame++) {
        scope.check()
        const bitmap = await worker.capture(frame, req.range.start + frameToFlicks(frame, req.fps))
        await writeFrame(encoder.child, bitmap)
        job.done++
        job.stale += worker.stalePaints
        worker.stalePaints = 0
        emit(job, 'rendering', undefined, false)
      }
      encoder.child.stdin.end()
      await encoder.done
      scope.check()
      return sequence ? dirname(path) : path
    } finally { scope.closeWorker(worker) }
  })
  try { return await Promise.all(pending) } finally {
    await scope.close()
    await Promise.allSettled(pending)
    job.scope.release(scope)
  }
}

async function run(job: Job) {
  let directory: string | undefined
  let audioTask: Promise<unknown> | undefined
  let audioFailure: unknown
  try {
    const req = job.req
    emit(job, 'preparing')
    await mkdir(dirname(req.output), { recursive: true })
    directory = await mkdtemp(join(dirname(req.output), '.cascade-export-'))
    const { ffmpeg } = await getFFmpegTools()
    job.scope.check()
    const plan = req.encoding
    const duration = plan.kind === 'audio' ? (req.range.end - req.range.start) / FLICKS : job.total * req.fps.den / req.fps.num
    const hasAudio = plan.audioArgs.length > 0
    const audio = hasAudio ? renderAudio(job.scope, ffmpeg, req, directory, duration, message => emit(job, plan.kind === 'audio' ? 'audio' : 'rendering', message, false)) : Promise.resolve(undefined)
    // Audio may fail before video finishes; terminate both passes immediately.
    audioTask = audio
    void audio.catch(error => { audioFailure = error; job.scope.cancel() })
    let paths: string[] = []
    if (plan.kind !== 'audio') {
      emit(job, 'rendering')
      try { paths = await segments(job, ffmpeg, directory, plan) } catch (error) {
        job.scope.check()
        if (!plan.fallback) throw error
        job.done = 0
        emit(job, 'rendering', `Hardware encoder failed; retrying in software. ${String(error)}`)
        paths = await segments(job, ffmpeg, directory, { ...plan, ...plan.fallback, inputArgs: plan.fallback.inputArgs, fallback: undefined })
      }
      emit(job, 'encoding')
    }
    const audioPath = await audio
    job.scope.check()
    const output = join(directory, `output.${plan.extension}`)
    emit(job, 'muxing')
    const audioInput = audioPath ? ['-f', 'f32le', '-ar', String(req.project.settings.sampleRate), '-ac', '2', '-i', audioPath] : []
    if (plan.kind === 'sequence') {
      await rename(paths[0], req.output)
    } else if (plan.kind === 'audio') {
      await job.scope.run(ffmpeg, [...audioInput, ...plan.audioArgs, '-t', String(duration), ...(plan.container ? ['-f', plan.container] : []), output])
      await rename(output, req.output)
    } else if (plan.twoPass === 'palette') {
      const palette = join(directory, 'palette.png')
      await job.scope.run(ffmpeg, ['-filter_threads', '1', '-i', paths[0], '-vf', 'palettegen', '-frames:v', '1', palette])
      await job.scope.run(ffmpeg, ['-filter_complex_threads', '1', '-i', paths[0], '-i', palette, '-lavfi', 'paletteuse', '-loop', '0', output])
      await rename(output, req.output)
    } else {
      const list = join(directory, 'concat.txt')
      const parts = partitionFrames(job.total, job.workers)
      await writeFile(list, paths.map((path, i) => `file '${path.replace(/'/g, "'\\''")}'\nduration ${(parts[i].end - parts[i].start) * req.fps.den / req.fps.num}\n`).join(''))
      await job.scope.run(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', list, ...audioInput,
        '-map', '0:v:0', '-c:v', 'copy', ...(audioPath ? ['-map', '1:a:0', ...plan.audioArgs] : ['-an']),
        '-t', String(duration), ...(plan.container === 'mp4' || plan.container === 'mov' ? ['-movflags', '+faststart', '-video_track_timescale', String(req.fps.num)] : []),
        ...(plan.container ? ['-f', plan.container] : []), output])
      await rename(output, req.output)
    }
    job.done = job.total
    emit(job, 'done')
  } catch (error) {
    const cause = audioFailure ?? error
    emit(job, job.cancelled ? 'cancelled' : 'error', cause instanceof Error ? cause.message : String(cause))
  } finally {
    await job.scope.close()
    await audioTask?.catch(() => {})
    if (job.ownerGone) job.owner.removeListener('destroyed', job.ownerGone)
    if (directory) await rm(directory, { recursive: true, force: true }).catch(console.warn)
    jobs.delete(job.id)
  }
}

async function stillImage(req: FrameRequest): Promise<NativeImage> {
  if (quitting) throw new Error('Application is quitting')
  const request: ExportRequest = { ...req, fps: req.project.settings.fps, range: { start: req.time, end: req.time + FLICKS }, output: join(tmpdir(), 'unused.png'), exporter: '', options: {}, encoding: { videoArgs: [], audioArgs: [], extension: 'png' } }
  validateRequest(request)
  clearTimeout(warmTimer)
  if (warm && (warm.job.width !== req.width || warm.job.height !== req.height)) { warm.dispose(); warm = undefined }
  warm ??= new RenderWorker(workerJob(request, 'frame'))
  warm.job = workerJob(request, 'frame')
  try {
    const buffer = await warm.capture(++stillIndex, req.time)
    return nativeImage.createFromBitmap(buffer, { width: req.width, height: req.height })
  } catch (error) { warm.dispose(); warm = undefined; throw error } finally {
    warmTimer = setTimeout(() => { warm?.dispose(); warm = undefined }, 30_000)
  }
}

const still = async (req: FrameRequest) => `data:image/png;base64,${(await stillImage(req)).toPNG().toString('base64')}`

/** Serialized with the other stills: the warm worker renders one frame at a time. */
function queued<T>(task: () => Promise<T>): Promise<T> {
  const next = stillChain.then(task)
  stillChain = next.catch(() => {})
  return next
}

export function registerExportIpc(): void {
  registerWorkerIpc()
  ipcMain.handle('export:start', (event, req: ExportRequest) => {
    if (quitting) throw new Error('Application is quitting')
    const total = validateRequest(req)
    if (!isAbsolute(req.output)) throw new Error('Export output must be an absolute path')
    req.output = resolve(req.output)
    if ([...jobs.values()].some(job => job.req.output === req.output)) throw new Error('An export is already writing this output')
    const parallel = req.workers || Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2), Math.floor(12_500_000 / (req.width * req.height))))
    const count = req.encoding.concatSafe && !req.encoding.twoPass && req.encoding.kind !== 'sequence' ? Math.min(total, parallel) : 1
    const job: Job = { id: randomUUID(), req, owner: event.sender, scope: new ExportScope(), total, done: 0, stale: 0, workers: count, started: Date.now(), lastProgress: 0, cancelled: false }
    jobs.set(job.id, job)
    job.ownerGone = () => { job.cancelled = true; job.scope.cancel() }
    event.sender.once('destroyed', job.ownerGone)
    // Return the id before emitting progress so callers can register their job immediately.
    job.finished = new Promise(resolve => { setImmediate(() => { void run(job).then(resolve, resolve) }) })
    return job.id
  })
  ipcMain.handle('export:cancel', async (event, id: string) => {
    const job = jobs.get(id)
    if (!job || job.owner !== event.sender) return
    job.cancelled = true
    job.scope.cancel()
    await job.finished
  })
  ipcMain.handle('export:frame', (_event, req: FrameRequest) => queued(() => still(req)))
  ipcMain.handle('export:saveFrame', (_event, req: FrameRequest & { output: string; format: 'png' | 'jpeg'; quality?: number }) => queued(async () => {
    if (typeof req.output !== 'string' || !isAbsolute(req.output) || /[\0\r\n]/.test(req.output)) throw new Error('Frame output must be an absolute path')
    if (req.format !== 'png' && req.format !== 'jpeg') throw new Error('Unsupported image format')
    const image = await stillImage(req)
    const output = resolve(req.output)
    await mkdir(dirname(output), { recursive: true })
    const quality = Math.round(Math.min(100, Math.max(1, Number(req.quality) || 92)))
    await writeFile(output, req.format === 'png' ? image.toPNG() : image.toJPEG(quality))
    return output
  }))
  ipcMain.handle('export:copyFrame', (_event, req: FrameRequest) => queued(async () => {
    const png = (await stillImage(req)).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  }))
  app.on('before-quit', event => {
    if (readyToQuit) return
    if (quitting) { event.preventDefault(); return }
    quitting = true
    event.preventDefault()
    clearTimeout(warmTimer)
    warm?.dispose()
    warm = undefined
    for (const job of jobs.values()) { job.cancelled = true; job.scope.cancel() }
    void Promise.allSettled([...jobs.values()].map(job => job.finished)).then(() => {
      readyToQuit = true
      app.quit()
    })
  })
}
