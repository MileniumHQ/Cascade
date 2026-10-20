import { spawn, type ChildProcess } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import type { HostInfo } from '../shared/ipc'

const children = new Set<ChildProcess>()
let quitting = false

export function spawnTracked(command: string, args: string[]): ReturnType<typeof spawn> {
  if (quitting) throw new Error('Application is quitting')
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.add(child)
  child.once('close', () => children.delete(child))
  // Callers also receive the error; this listener prevents an unhandled process error.
  child.on('error', () => {})
  return child
}

export function stopMediaProcesses(): void {
  quitting = true
  for (const child of children) child.kill('SIGKILL')
}

export async function capture(command: string, args: string[], timeoutMs = 0): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = spawnTracked(command, args)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-4_000_000) })
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-256_000) })
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }) })
  })
}

export interface FFmpegTools { ffmpeg: string; ffprobe: string | null; version: string }
let toolsPromise: Promise<FFmpegTools> | undefined
export function getFFmpegTools(): Promise<FFmpegTools> {
  return toolsPromise ??= (async () => {
    let ffmpeg = 'ffmpeg'
    let version = ''
    for (const candidate of [...new Set(['ffmpeg', ffmpegStatic?.replace(/app\.asar(?=[/\\])/g, 'app.asar.unpacked')].filter((x): x is string => !!x))]) {
      try {
        const result = await capture(candidate, ['-version'], 10_000)
        if (result.code === 0) { ffmpeg = candidate; version = result.stdout.split('\n')[0]; break }
      } catch { /* Try the bundled binary. */ }
    }
    if (!version) throw new Error('ffmpeg could not be found on PATH or in the application bundle')
    let ffprobe: string | null = null
    try { if ((await capture('ffprobe', ['-version'], 10_000)).code === 0) ffprobe = 'ffprobe' } catch { /* ffmpeg stderr is the fallback. */ }
    return { ffmpeg, ffprobe, version }
  })()
}

let infoPromise: Promise<HostInfo['ffmpeg']> | undefined
export function getFFmpegInfo(): Promise<HostInfo['ffmpeg']> {
  return infoPromise ??= (async () => {
    const tools = await getFFmpegTools()
    const result = await capture(tools.ffmpeg, ['-hide_banner', '-encoders'], 10_000)
    let hwEncoders = [...result.stdout.matchAll(/^\s*V\S*\s+(\S*(?:vaapi|nvenc|qsv|videotoolbox|amf|v4l2m2m)\S*)\s/gm)].map((m) => m[1])
    // Listing VAAPI encoders doesn't mean a device/driver is available. Verify every advertised codec.
    const supported = await Promise.all(hwEncoders.map(async (encoder) => {
      if (!encoder.endsWith('_vaapi')) return encoder
      try {
        const test = await capture(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-vaapi_device', '/dev/dri/renderD128',
          '-f', 'lavfi', '-i', 'color=size=128x128:rate=1', '-vf', 'format=nv12,hwupload', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'], 10_000)
        return test.code === 0 ? encoder : null
      } catch { return null }
    }))
    hwEncoders = supported.filter((v): v is string => v !== null)
    return { path: tools.ffmpeg, version: tools.version, hwEncoders }
  })().catch((error: unknown) => ({ path: '', version: String(error), hwEncoders: [] }))
}
