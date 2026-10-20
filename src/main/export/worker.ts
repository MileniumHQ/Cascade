import { BrowserWindow, ipcMain, type IpcMainEvent, type NativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import type { RenderWorkerJob } from '../../shared/ipc'
import type { Flicks } from '../../shared/time'
import { readStamp } from './plan'

const workers = new Map<number, RenderWorker>()
interface Pending<T> { resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
function deferred<T>(timeout: number): { promise: Promise<T>; pending: Pending<T> } {
  let pending!: Pending<T>
  const promise = new Promise<T>((resolve, reject) => {
    pending = { resolve, reject, timer: setTimeout(() => reject(new Error('Render worker timed out')), timeout) }
  })
  // Initialization/process errors can precede the caller awaiting this promise.
  void promise.catch(() => {})
  return { promise, pending }
}

export function registerWorkerIpc(): void {
  ipcMain.handle('render:job', event => {
    const worker = workers.get(event.sender.id)
    if (!worker) throw new Error('Not an export worker')
    return worker.job
  })
  const route = (channel: string, callback: (worker: RenderWorker, args: unknown[]) => void) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      const worker = workers.get(event.sender.id)
      if (worker) callback(worker, args)
    })
  }
  route('render:done', worker => worker.initialized())
  route('render:error', (worker, args) => worker.fail(new Error(String(args[0]))))
  route('render:frameReady', (worker, args) => worker.frameReady(Number(args[0])))
  route('render:audioChunk', (worker, args) => worker.audioReady(Number(args[0]), args[1]))
}

export class RenderWorker {
  readonly win: BrowserWindow
  readonly ready: Promise<void>
  stalePaints = 0
  private init: Pending<void>
  private frame?: Pending<Buffer> & { index: number; ready: boolean }
  private audio?: Pending<ArrayBuffer> & { index: number }
  private failure?: Error
  private disposed = false
  private retry?: ReturnType<typeof setInterval>

  constructor(public job: RenderWorkerJob) {
    const init = deferred<void>(120_000)
    this.ready = init.promise
    this.init = init.pending
    this.win = new BrowserWindow({
      width: job.width, height: job.height + job.stampHeight, useContentSize: true,
      frame: false, show: false, backgroundColor: '#000000',
      webPreferences: {
        preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        offscreen: { useSharedTexture: false }, backgroundThrottling: false
      }
    })
    workers.set(this.win.webContents.id, this)
    // Constructor geometry is screen-clamped on Linux. This call is required even at 4K.
    this.win.setContentSize(job.width, job.height + job.stampHeight)
    this.win.webContents.setZoomFactor(1)
    this.win.webContents.setFrameRate(240)
    this.win.webContents.on('paint', (_event, _dirty, image) => this.paint(image))
    this.win.webContents.on('render-process-gone', (_event, details) => this.fail(new Error(`Render worker exited: ${details.reason}`)))
    this.win.webContents.on('console-message', (details) => {
      // Stage.renderExact logs plugin failures; never silently export the previous video frame.
      if (details.level === 'error') this.fail(new Error(`Render worker: ${details.message}`))
    })
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.win.on('closed', () => this.dispose())
    const dev = process.env.ELECTRON_RENDERER_URL
    const loading = dev
      ? this.win.loadURL(`${dev.replace(/\/$/, '')}/render.html`)
      : this.win.loadFile(fileURLToPath(new URL('../renderer/render.html', import.meta.url)))
    void loading.catch(error => this.fail(error))
  }

  initialized() { clearTimeout(this.init.timer); this.init.resolve() }
  fail(error: Error) {
    this.failure ??= error
    clearTimeout(this.init.timer)
    this.init.reject(error)
    if (this.frame) { clearTimeout(this.frame.timer); this.frame.reject(error); this.frame = undefined }
    if (this.audio) { clearTimeout(this.audio.timer); this.audio.reject(error); this.audio = undefined }
    clearInterval(this.retry)
  }
  private check() {
    if (this.failure) throw this.failure
    if (this.disposed) throw new Error('Render worker is closed')
    if (this.frame || this.audio) throw new Error('Render worker already has a pending command')
  }
  async capture(index: number, time: Flicks): Promise<Buffer> {
    await this.ready
    this.check()
    const request = deferred<Buffer>(120_000)
    this.frame = { ...request.pending, index, ready: false }
    this.win.webContents.send('render:command', { type: 'frame', index, time })
    // A paint can be coalesced, including after a stale invalidation. Retry without busy waiting.
    this.retry = setInterval(() => {
      if (this.frame?.ready && !this.win.isDestroyed()) this.win.webContents.invalidate()
    }, 4)
    try { return await request.promise } finally {
      clearInterval(this.retry)
      clearTimeout(request.pending.timer)
      this.frame = undefined
    }
  }
  frameReady(index: number) {
    if (this.frame?.index !== index) return
    this.frame.ready = true
    this.win.webContents.invalidate()
  }
  private paint(image: NativeImage) {
    const pending = this.frame
    if (!pending?.ready) return
    const size = image.getSize()
    if (size.width !== this.job.width || size.height !== this.job.height + this.job.stampHeight) {
      this.fail(new Error(`Unexpected capture size ${size.width}x${size.height}; expected ${this.job.width}x${this.job.height + this.job.stampHeight}`))
      return
    }
    // Inspect one strip row first. Stale paints must not copy an entire 4K bitmap.
    const strip = this.job.width < 8 ? this.job.stampHeight : 1
    const stamp = image.crop({ x: 0, y: this.job.height + (strip === 1 ? Math.floor(this.job.stampHeight / 2) : 0), width: this.job.width, height: strip }).toBitmap()
    if (readStamp(stamp, this.job.width, 0, strip) !== pending.index) {
      this.stalePaints++
      // invalidate() can synchronously return Chromium's cached image. Yield to the compositor.
      return
    }
    clearTimeout(pending.timer)
    this.frame = undefined
    // The stamp is below the image: a subarray crops it without another full-frame copy.
    pending.resolve(image.toBitmap().subarray(0, this.job.width * this.job.height * 4))
  }
  async renderAudio(index: number, start: number, duration: number): Promise<ArrayBuffer> {
    await this.ready
    this.check()
    const request = deferred<ArrayBuffer>(120_000)
    this.audio = { ...request.pending, index }
    this.win.webContents.send('render:command', { type: 'audio', index, start, duration })
    try { return await request.promise } finally { clearTimeout(request.pending.timer); this.audio = undefined }
  }
  audioReady(index: number, value: unknown) {
    if (this.audio?.index !== index) return
    if (!(value instanceof ArrayBuffer)) { this.fail(new Error('Invalid audio worker payload')); return }
    clearTimeout(this.audio.timer)
    this.audio.resolve(value)
    this.audio = undefined
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.fail(new Error('Render worker closed'))
    // webContents.id throws after destruction; remove using the registered instance.
    for (const [id, worker] of workers) if (worker === this) workers.delete(id)
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}
