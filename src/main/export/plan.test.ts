import { describe, expect, it } from 'vitest'
import { partitionFrames, readStamp, validatePlan, validateRequest } from './plan'
import { createProject } from '../../shared/project'
import { FLICKS } from '../../shared/time'
import { exporters } from '../../plugins/builtin/exporters'
import type { ExportRequest } from '../../shared/ipc'

function request(): ExportRequest {
  const project = createProject('Export test')
  return { project, timelineId: project.activeTimeline, width: 1920, height: 1080, fps: { num: 30000, den: 1001 }, range: { start: 0, end: 60 * FLICKS }, output: '/tmp/test.mp4', exporter: 'third-party', options: {}, encoding: { videoArgs: ['-c:v', 'libx264'], audioArgs: [], extension: 'mp4', container: 'mp4' } }
}

describe('frame partition and capture integrity', () => {
  it('partitions every frame exactly once even across fractional segment boundaries', () => {
    for (const total of [1, 7, 1799, 17983]) for (const count of [1, 4, 6, 32]) {
      const parts = partitionFrames(total, count)
      expect(parts[0].start).toBe(0)
      expect(parts.at(-1)!.end).toBe(total)
      expect(parts.reduce((sum, part) => sum + part.end - part.start, 0)).toBe(total)
      parts.forEach((part, i) => {
        expect(part.end).toBeGreaterThan(part.start)
        if (i) expect(part.start).toBe(parts[i - 1].end)
      })
    }
  })
  it('rounds only the complete half-open range to whole output frames', () => {
    expect(validateRequest(request())).toBe(1799)
    const req = request()
    req.range = { start: 12 * FLICKS, end: 612 * FLICKS }
    expect(validateRequest(req)).toBe(17983)
  })
  it('supports stamps on still images narrower than eight pixels', () => {
    for (const width of [1, 3, 7]) {
      const strip = 8, columns = Math.min(8, width), rows = Math.ceil(8 / columns)
      const data = Buffer.alloc(width * strip * 4)
      const index = 0x12345678
      for (let i = 0; i < 8; i++) {
        const col = i % columns, row = Math.floor(i / columns)
        const green = ((index >>> (i * 4)) & 15) * 16 + 8
        for (let y = Math.floor(row * strip / rows); y < Math.floor((row + 1) * strip / rows); y++) {
          data.set([117, green, 255 - green, 255], (y * width + col) * 4)
        }
      }
      expect(readStamp(data, width, 0, strip)).toBe(index)
    }
  })
  it('decodes a full-width stamp including the high bits and rejects corrupt paints', () => {
    const width = 1920, height = 2, strip = 8
    const buffer = Buffer.alloc(width * (height + strip) * 4)
    const index = 0x6abcdef1
    for (let y = height; y < height + strip; y++) for (let x = 0; x < width; x++) {
      const value = ((index >>> (Math.floor(x * 8 / width) * 4)) & 15) * 16 + 8
      const offset = (y * width + x) * 4
      buffer.set([117, value, 255 - value, 255], offset)
    }
    expect(readStamp(buffer, width, height, strip)).toBe(index)
    buffer.fill(0, (height + strip / 2) * width * 4)
    expect(readStamp(buffer, width, height, strip)).toBeNull()
    expect(readStamp(Buffer.alloc(4), width, height, strip)).toBeNull()
  })
})

describe('plugin encoding plans', () => {
  it('validates every built-in plan with and without VAAPI', () => {
    for (const exporter of exporters) for (const hwEncoders of [[], ['h264_vaapi', 'hevc_vaapi', 'av1_vaapi']]) {
      const options = Object.fromEntries(exporter.options.map(o => [o.id, o.default]))
      const plan = exporter.ffmpeg(options, { width: 1920, height: 1080, fps: { num: 30, den: 1 }, hasAudio: true, hwEncoders })
      expect(() => validatePlan(plan)).not.toThrow()
    }
  })
  it('respects hardware preference and supplies the complete software fallback', () => {
    const exporter = exporters.find(e => e.id === 'mp4-h264')!
    const info = { width: 1920, height: 1080, fps: { num: 30, den: 1 }, hasAudio: true, hwEncoders: ['h264_vaapi'] }
    const hw = exporter.ffmpeg({}, info)
    expect(hw.videoArgs).toContain('h264_vaapi')
    expect(hw.fallback!.videoArgs).toContain('libx264')
    expect(exporter.ffmpeg({ hardware: false }, info).videoArgs).toContain('libx264')
  })
  it('rejects attempts to inject inputs, output files or file-opening filters', () => {
    for (const videoArgs of [['-i', '/secret'], ['-vf', 'movie=/secret'], ['-c:v', 'libx264', '/tmp/other'], ['-vf', 'format=nv12,hwupload;movie=x']]) {
      expect(() => validatePlan({ videoArgs, audioArgs: [], extension: 'mp4' })).toThrow()
    }
    const req = request()
    req.range.end = Infinity
    expect(() => validateRequest(req)).toThrow()
  })
})
