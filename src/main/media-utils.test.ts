import { describe, expect, it } from 'vitest'
import { PeakBuilder, thumbnailInterval } from './media-utils'
import { mediaUrl, parseRange, serveMedia } from './protocols'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('HTTP byte ranges', () => {
  it('handles closed, open, suffix and clamped ranges without truncating large offsets', () => {
    const size = 8_000_000_000
    expect(parseRange(null, size)).toBeNull()
    expect(parseRange('bytes=4294967296-', size)).toEqual({ start: 4294967296, end: size - 1 })
    expect(parseRange('bytes=1-9', 5)).toEqual({ start: 1, end: 4 })
    expect(parseRange('bytes=-3', 5)).toEqual({ start: 2, end: 4 })
    expect(parseRange('bytes=-10', 5)).toEqual({ start: 0, end: 4 })
  })

  it('rejects unsatisfiable, malformed and multipart requests', () => {
    for (const value of ['bytes=5-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,3-4', 'items=0-1', 'bytes=9007199254740992-']) {
      expect(parseRange(value, 5)).toBe(false)
    }
    expect(parseRange('bytes=0-', 0)).toBe(false)
  })

  it('streams a sparse multi-GB file and reports correct HEAD and 416 headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-range-'))
    const path = join(dir, 'special # % 日本語.f32')
    const size = 5_000_000_000
    try {
      const file = await open(path, 'w')
      await file.truncate(size)
      await file.write(Buffer.from([1, 2, 3, 4]), 0, 4, size - 4)
      await file.close()
      const response = await serveMedia(new Request(mediaUrl(path), { headers: { Range: 'bytes=-4' } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
      const head = await serveMedia(new Request(mediaUrl(path), { method: 'HEAD' }))
      expect(head.headers.get('Content-Length')).toBe(String(size))
      expect(await head.text()).toBe('')
      const invalid = await serveMedia(new Request(mediaUrl(path), { headers: { Range: `bytes=${size}-` } }))
      expect(invalid.status).toBe(416)
      expect(invalid.headers.get('Content-Range')).toBe(`bytes */${size}`)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('thumbnail sampling', () => {
  it('provides half-second short-clip previews and limits long media to 600 samples', () => {
    expect(thumbnailInterval(10)).toBe(0.5)
    for (const duration of [31, 599, 600, 601, 6480, 43200, 4_000_000]) {
      expect(Math.ceil(duration / thumbnailInterval(duration))).toBeLessThanOrEqual(600)
    }
  })
})

describe('streaming waveform peaks', () => {
  it('preserves min/max across byte and sample boundaries, including the final partial bucket', () => {
    const input = Buffer.alloc(81 * 4)
    for (let i = 0; i < 81; i++) input.writeFloatLE(i === 0 ? -0.75 : i === 39 ? 0.9 : i === 40 ? -0.5 : 0.25, i * 4)
    const peaks = new PeakBuilder()
    const output = Buffer.concat([peaks.push(input.subarray(0, 3)), peaks.push(input.subarray(3, 163)), peaks.push(input.subarray(163)), peaks.finish()])
    expect(peaks.length).toBe(3)
    expect(output.length).toBe(24)
    expect(output.readFloatLE(0)).toBe(-0.75)
    expect(output.readFloatLE(4)).toBeCloseTo(0.9)
    expect(output.readFloatLE(8)).toBe(-0.5)
    expect(output.readFloatLE(12)).toBe(0.25)
    expect(output.readFloatLE(16)).toBe(0.25)
    expect(output.readFloatLE(20)).toBe(0.25)
  })

  it('normalizes out-of-range and nonfinite samples and emits no empty trailing pair', () => {
    const input = Buffer.alloc(40 * 4)
    input.writeFloatLE(-4, 0)
    input.writeFloatLE(4, 4)
    input.writeFloatLE(NaN, 8)
    const peaks = new PeakBuilder()
    const output = peaks.push(input)
    expect(output.readFloatLE(0)).toBe(-1)
    expect(output.readFloatLE(4)).toBe(1)
    expect(peaks.finish().length).toBe(0)
  })
})
