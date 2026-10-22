import { describe, expect, it } from 'vitest'
import { alignUnits, applyAlignment, planAlignment } from './align'
import type { Transcript } from '../shared/ipc'
import { FLICKS } from '../shared/time'

const MS = FLICKS / 1000
const transcript = (words: [string, number, number][], offset = 0): Transcript => ({ path: 'p', model: 'm', language: 'en', segments: [{
  text: words.map((w) => w[0]).join(' '), start: 0, end: 0,
  words: words.map(([text, start, end]) => ({ text, start: offset + start * MS, end: offset + end * MS, p: 0.9 }))
}] })

describe('alignment units', () => {
  it('keeps letters, digits and apostrophes like the upstream processor', () => {
    expect(alignUnits('Hello,')).toEqual(['Hello'])
    expect(alignUnits("don't")).toEqual(["don't"])
    expect(alignUnits('co-op.')).toEqual(['coop'])
    expect(alignUnits('85%')).toEqual(['85'])
    expect(alignUnits('café')).toEqual(['café'])
    expect(alignUnits('—')).toEqual([])
  })
  it('splits CJK ideographs into single units', () => {
    expect(alignUnits('我们A1好')).toEqual(['我', '们', 'A1', '好'])
  })
})

describe('chunk plan', () => {
  // One word per second with a long pause after word 44 (at 45 s).
  const words = Array.from({ length: 120 }, (_, i) => {
    const start = i * 1000 + (i >= 45 ? 3000 : 0)
    return { text: `w${i}.`, start, end: start + 600 }
  })
  it('cuts at the widest pause between the minimum and maximum length', () => {
    const chunks = planAlignment(words, 130_000)
    expect(chunks[0].words.at(-1)).toBe(44)
    expect(chunks[1].words[0]).toBe(45)
    expect(chunks.flatMap((c) => c.words)).toEqual(words.map((_, i) => i))
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(92_000)
  })
  it('pads at most a second beyond the outer words and never overlaps chunks', () => {
    const chunks = planAlignment(words, 130_000)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].end).toBe(44_600 + 1000)
    expect(chunks[1].start).toBe(48_000 - 1000)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end)
  })
  it('snaps a cut into an acoustic silence inside the pause', () => {
    const tight = [{ text: 'a', start: 0, end: 1000 }, { text: 'b', start: 1200, end: 2000 }, { text: 'c', start: 2100, end: 3000 }]
    const chunks = planAlignment(tight, 3500, [{ start: 1050, end: 1190 }], { minMs: 500, maxMs: 1500, padMs: 1000 })
    expect(chunks[0].end).toBe(1120)
    expect(chunks[1].start).toBe(1120)
  })
  it('skips unit-less words and counts multi-unit words', () => {
    const chunks = planAlignment([{ text: 'hi', start: 0, end: 300 }, { text: '—', start: 300, end: 400 }, { text: '我们', start: 400, end: 900 }], 1000)
    expect(chunks).toEqual([{ start: 0, end: 1000, words: [0, 2], counts: [1, 2], units: ['hi', '我', '们'] }])
  })
})

describe('applying aligned times', () => {
  it('maps unit times to words with the source offset and widens single-frame words', () => {
    const offset = 10 * FLICKS
    const t = transcript([['Hello,', 0, 500], ['big', 600, 900], ['我们', 1000, 1800]], offset)
    const chunks = planAlignment(t.segments[0].words.map((w) => ({ text: w.text, start: (w.start - offset) / MS, end: (w.end - offset) / MS })), 2000)
    const n = applyAlignment(t, chunks, [{ start: [80, 480, 800, 1040], end: [400, 480, 1040, 1600] }], offset)
    expect(n).toBe(3)
    expect(t.segments[0].words.map((w) => [(w.start - offset) / MS, (w.end - offset) / MS])).toEqual([[80, 400], [480, 560], [800, 1600]])
    expect(t.segments[0].start).toBe(offset + 80 * MS)
    expect(t.segments[0].end).toBe(offset + 1600 * MS)
  })
  it('keeps existing timing for a failed or malformed chunk', () => {
    const t = transcript([['one', 0, 500], ['two', 600, 900]])
    const chunks = planAlignment(t.segments[0].words.map((w) => ({ text: w.text, start: w.start / MS, end: w.end / MS })), 1000)
    expect(applyAlignment(t, chunks, [{ error: 'align_words failed (-3)' }], 0)).toBe(0)
    expect(applyAlignment(t, chunks, [{ start: [400, 100], end: [500, 200] }], 0)).toBe(0)
    expect(applyAlignment(t, chunks, [{ start: [100], end: [200] }], 0)).toBe(0)
    expect(t.segments[0].words.map((w) => w.start / MS)).toEqual([0, 600])
  })
  it('places punctuation-only words at the previous word end', () => {
    const t = transcript([['wait', 0, 400], ['—', 400, 500], ['what', 600, 900]])
    const chunks = planAlignment(t.segments[0].words.map((w) => ({ text: w.text, start: w.start / MS, end: w.end / MS })), 1000)
    applyAlignment(t, chunks, [{ start: [80, 560], end: [320, 880] }], 0)
    expect(t.segments[0].words.map((w) => [w.start / MS, w.end / MS])).toEqual([[80, 320], [320, 320], [560, 880]])
  })
})
