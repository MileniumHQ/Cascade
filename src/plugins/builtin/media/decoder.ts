import { ALL_FORMATS, CanvasSink, Input, UrlSource, type WrappedCanvas } from 'mediabunny'

/** Frame-exact streaming decode. Keep one frame of lookahead to select the frame containing t. */
export class FrameDecoder {
  private input: Input
  private sink: Promise<CanvasSink | null>
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null
  private current: WrappedCanvas | null = null
  private next: WrappedCanvas | null = null
  private last = -Infinity
  private closed = false

  constructor(url: string) {
    this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    this.sink = this.input.getPrimaryVideoTrack().then(t => t ? new CanvasSink(t, { poolSize: 3 }) : null).catch(error => {
      if (this.closed) return null
      throw error
    })
    // Audio capability probing can dispose a visual instance before metadata resolves.
    void this.sink.catch(() => {})
  }

  async frame(t: number): Promise<WrappedCanvas | null> {
    const sink = await this.sink
    if (!sink || this.closed) return null
    // Sparse contact-sheet requests should seek instead of decoding every intervening frame.
    if (!this.iter || t < this.last || t - this.last > 1) {
      await this.iter?.return()
      // canvasesAtTimestamps batches until the iterable finishes or crosses a keyframe.
      // An open-ended, demand-fed iterable deadlocks on its first timestamp. The sequential
      // iterator instead decodes ahead in a bounded queue and reuses the decoder across frames.
      this.iter = sink.canvases(t)
      this.current = (await this.iter.next()).value ?? null
      this.next = (await this.iter.next()).value ?? null
    }
    this.last = t
    while (this.next && this.next.timestamp <= t + 1e-8) {
      this.current = this.next
      this.next = (await this.iter.next()).value ?? null
    }
    return this.current
  }

  dispose() {
    this.closed = true
    void this.iter?.return().catch(() => {})
    this.input.dispose()
  }
}
