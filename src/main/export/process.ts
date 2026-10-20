import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { RenderWorker } from './worker'

/** One scope owns every process/window it starts. Closing waits for ffmpeg before deleting files. */
export class ExportScope {
  readonly abort = new AbortController()
  private processes = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  private workers = new Set<RenderWorker>()
  private children = new Set<ExportScope>()
  check() { if (this.abort.signal.aborted) throw new Error('Export cancelled') }
  child() { this.check(); const scope = new ExportScope(); this.children.add(scope); return scope }
  release(scope: ExportScope) { this.children.delete(scope) }
  worker(job: ConstructorParameters<typeof RenderWorker>[0]) {
    this.check()
    const worker = new RenderWorker(job)
    this.workers.add(worker)
    return worker
  }
  closeWorker(worker: RenderWorker) { worker.dispose(); this.workers.delete(worker) }
  start(command: string, args: string[]) {
    this.check()
    const child = spawn(command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16000) })
    // A failed encoder closes its input before the next write; keep EPIPE handled.
    child.stdin.on('error', () => {})
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)))
    })
    this.processes.set(child, done)
    void done.then(() => this.processes.delete(child), () => this.processes.delete(child))
    return { child, done }
  }
  async run(command: string, args: string[]) {
    const { child, done } = this.start(command, args)
    child.stdin.end()
    await done
    this.check()
  }
  cancel() {
    if (this.abort.signal.aborted) return
    this.abort.abort()
    for (const scope of this.children) scope.cancel()
    for (const worker of this.workers) worker.dispose()
    this.workers.clear()
    for (const child of this.processes.keys()) child.kill('SIGKILL')
  }
  async close() {
    this.cancel()
    await Promise.allSettled([...this.processes.values(), ...[...this.children].map(scope => scope.close())])
  }
}

/** Await the write callback: bounded buffering, correct lifetime of the native BGRA buffer. */
export function writeFrame(child: ChildProcessWithoutNullStreams, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.stdin.destroyed) { reject(new Error('Encoder input closed')); return }
    child.stdin.write(buffer, error => error ? reject(error) : resolve())
  })
}
