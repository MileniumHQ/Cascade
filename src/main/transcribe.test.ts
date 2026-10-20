import { describe, expect, it } from 'vitest'
import { parseWhisperJSON, createTranscriptionService, constrainToSpeech } from './transcribe'
import { FLICKS } from '../shared/time'
import { groupCaptions } from '../plugins/builtin/captions/group'

const token = (text: string, dtw: number, from: number, to: number, id = 100) => ({ text, id, p: 0.9, t_dtw: dtw, offsets: { from, to } })
describe('whisper full JSON', () => {
  it('uses DTW centiseconds, merges BPE pieces and adds the exact source range offset', () => {
    const t = parseWhisperJSON({ result: { language: 'en' }, transcription: [{ text: ' Transcription works.', offsets: { from: 0, to: 8000 }, tokens: [
      token('[_BEG_]', -1, -10, -10, 50364), token(' Trans', 125, 1000, 1450), token('cription', 144, 1450, 1700),
      token(' works', 200, 1900, 2400), token('.', 235, 2400, 2450), token('[_EOT_]', -1, -10, -10, 50257)
    ] }] }, '/video', 'model', 30 * FLICKS)
    expect(t.segments[0].words).toEqual([
      { text: 'Transcription', start: 31.25 * FLICKS, end: Math.round(31.95 * FLICKS), p: 0.9 },
      { text: 'works.', start: 32 * FLICKS, end: Math.round(32.45 * FLICKS), p: 0.9 }
    ])
  })
  it('uses acoustic silence to trim a bounded DTW word end and clamps to range end', () => {
    const t = parseWhisperJSON({ transcription: [{ text: '', offsets: { from: 0, to: 10000 }, tokens: [
      token(' Hello', 100, 1000, 1300), token(' world', 500, 5000, 5300)
    ] }] }, 'p', 'm', 0, 5.1 * FLICKS)
    constrainToSpeech(t, [{ start: 1.3 * FLICKS, end: 4.8 * FLICKS }])
    expect(t.segments).toHaveLength(2)
    expect(t.segments[0].words[0].end).toBe(1.3 * FLICKS)
    expect(t.segments[1].end).toBe(5.1 * FLICKS)
  })
  it('pulls a post-pause onset to the speech boundary without changing interior DTW words', () => {
    const t = parseWhisperJSON({ transcription: [{ text: '', offsets: { from: 0, to: 6000 }, tokens: [
      token(' One', 100, 1000, 1300), token(' Two', 320, 3000, 3500), token(' Three', 380, 3600, 4000)
    ] }] }, 'p', 'm')
    constrainToSpeech(t, [{ start: 1.4 * FLICKS, end: 3 * FLICKS }])
    const words = t.segments.flatMap(s => s.words)
    expect(words[0].end).toBe(1.4 * FLICKS)
    expect(words[1].start).toBe(3 * FLICKS)
    expect(words[2].start).toBe(3.8 * FLICKS)
  })
  it('falls back to independent token offsets when DTW anchors collapse', () => {
    const t = parseWhisperJSON({ transcription: [{ text: '', offsets: { from: 0, to: 6000 }, tokens: [
      token(' Watch', 200, 1000, 1500), token(' a', 200, 1500, 1700), token(' show.', 200, 1700, 2200), token(' Next.', 300, 3000, 3300)
    ] }] }, 'p', 'm')
    const words = t.segments.flatMap(s => s.words)
    expect(words.map(w => w.start)).toEqual([FLICKS, 1.5*FLICKS, 1.7*FLICKS, 3*FLICKS])
    expect(words.every(w => w.end > w.start)).toBe(true)
    const captions = groupCaptions(t, { sourceIn: 0, start: 0, speed: 1, end: 6 * FLICKS })
    expect(captions.map(c => c.text.replace(/\n/g, ' ')).join(' ')).toBe('Watch a show. Next.')
    expect(captions.every((c, i) => c.end > c.start && (!i || c.start >= captions[i - 1].end))).toBe(true)
  })
  it('expands reversed-anchor fallback when token offsets cross adjacent DTW anchors', () => {
    const t = parseWhisperJSON({ transcription: [{ text: '', offsets: { from: 0, to: 6000 }, tokens: [
      token(' We', 190, 1000, 1500), token(' watch', 205, 1500, 1700), token(' a', 200, 1700, 1800),
      token(' show.', 210, 1800, 2200), token(' Next.', 300, 3000, 3300)
    ] }] }, 'p', 'm', 30 * FLICKS)
    const words = t.segments.flatMap(s => s.words)
    expect(words.map(w => w.start)).toEqual([31, 31.5, 31.7, 32.1, 33].map(s => Math.round(s * FLICKS)))
    expect(words.every(w => w.end > w.start)).toBe(true)
    const captions = groupCaptions(constrainToSpeech(t, []), { sourceIn: 30 * FLICKS, start: 0, speed: 2, end: 3 * FLICKS })
    expect(captions.map(c => c.text.replace(/\n/g, ' ')).join(' ')).toBe('We watch a show. Next.')
    expect(captions.every((c, i) => c.end > c.start && (!i || c.start >= captions[i - 1].end))).toBe(true)
  })
  it('accepts empty speech but rejects missing alignment', () => {
    expect(parseWhisperJSON({ transcription: [] }, 'p', 'm').segments).toEqual([])
    expect(() => parseWhisperJSON({ transcription: [{ text: 'hi', offsets: { from: 0, to: 1 }, tokens: [{ text: 'hi', id: 1, p: 1 }] }] }, 'p', 'm')).toThrow(/timestamps/)
  })
  it('preserves words through grouping when both timestamp estimates collapse', () => {
    const t = parseWhisperJSON({ transcription: [{ text: '', offsets: { from: 0, to: 6000 }, tokens: [
      token(' All', 100, 1000, 1000), token(' these', 100, 1000, 1000), token(' words.', 100, 1000, 1000),
      token(' Next.', 220, 2200, 2500)
    ] }] }, 'p', 'm')
    const words = t.segments.flatMap(s => s.words)
    expect(words.map(w => w.start)).toEqual([1, 1.4, 1.8, 2.2].map(s => Math.round(s * FLICKS)))
    expect(words.every(w => w.end > w.start && Number.isSafeInteger(w.start))).toBe(true)
    const captions = groupCaptions(t, { sourceIn: 0, start: 0, speed: 1, end: 6 * FLICKS })
    expect(captions.map(c => c.text.replace(/\n/g, ' ')).join(' ')).toBe('All these words. Next.')
  })
  it('rejects fractional/reversed ranges before starting processes', async () => {
    const service = createTranscriptionService('/does-not-exist')
    await expect(service.run('/none', { range: { start: 1.5, end: 5 } })).rejects.toThrow(/range/)
    await expect(service.run('/none', { range: { start: 5, end: 4 } })).rejects.toThrow(/range/)
  })
})
