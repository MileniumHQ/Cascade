import { ALL_FORMATS, CanvasSink, Input, UrlSource, type WrappedCanvas } from 'mediabunny'

/**
 * Frame-exact video decoding for export (WebCodecs via mediabunny).
 * Requests are expected to be mostly monotonic; going backwards restarts the decode pipeline.
 */
export class FrameDecoder {
  private input: Input
  private sink: Promise<CanvasSink | null>
  private iter: AsyncGenerator<WrappedCanvas | null> | null = null
  private queue: number[] = []
  private wake: (() => void) | null = null
  private last = -Infinity
  private closed = false

  constructor(url: string) {
    this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    this.sink = this.input.getPrimaryVideoTrack().then((t) => (t ? new CanvasSink(t, { poolSize: 3 }) : null))
  }

  private async *timestamps(): AsyncGenerator<number> {
    while (!this.closed) {
      if (this.queue.length) yield this.queue.shift()!
      else await new Promise<void>((r) => (this.wake = r))
    }
  }

  /** Decoded canvas for the frame shown at `t` seconds. */
  async frame(t: number): Promise<WrappedCanvas | null> {
    const sink = await this.sink
    if (!sink) return null
    if (!this.iter || t < this.last) {
      void this.iter?.return(undefined)
      this.queue = []
      this.iter = sink.canvasesAtTimestamps(this.timestamps())
    }
    this.last = t
    this.queue.push(t)
    this.wake?.()
    this.wake = null
    const r = await this.iter.next()
    return r.done ? null : r.value
  }

  dispose() {
    this.closed = true
    this.wake?.()
    void this.iter?.return(undefined)
    this.input.dispose?.()
  }
}
