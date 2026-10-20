import { describe, expect, it, vi } from 'vitest'

const starts: number[] = []
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  UrlSource: class {},
  Input: class { async getPrimaryVideoTrack() { return {} } dispose() {} },
  CanvasSink: class {
    async *canvases(start: number) {
      starts.push(start)
      for (let frame = Math.floor(start * 30); frame < 1000; frame++) {
        yield { canvas: { frame }, timestamp: frame / 30, duration: 1 / 30 }
      }
    }
  }
}))
import { FrameDecoder } from '../../plugins/builtin/media/decoder'

describe('frame-exact streaming decoder', () => {
  it('resolves its first request without requiring a future timestamp', async () => {
    const decoder = new FrameDecoder('media://test')
    expect((await decoder.frame(0))?.timestamp).toBe(0)
    decoder.dispose()
  }, 1000)
  it('holds a source frame at higher output fps and never selects the next frame early', async () => {
    const decoder = new FrameDecoder('media://test')
    expect((await decoder.frame(0))?.timestamp).toBe(0)
    expect((await decoder.frame(1 / 60))?.timestamp).toBe(0)
    expect((await decoder.frame(1 / 30))?.timestamp).toBe(1 / 30)
    expect((await decoder.frame(0.099))?.timestamp).toBe(2 / 30)
    decoder.dispose()
  })
  it('seeks for backwards and sparse requests, keeping sequential requests on one decoder', async () => {
    starts.length = 0
    const decoder = new FrameDecoder('media://test')
    await decoder.frame(5)
    await decoder.frame(5.03)
    await decoder.frame(1)
    await decoder.frame(15)
    expect(starts).toEqual([5, 1, 15])
    decoder.dispose()
  })
})
