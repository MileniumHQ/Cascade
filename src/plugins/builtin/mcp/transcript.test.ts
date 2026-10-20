import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import type { SourceAnalysis, AnalysisWord } from '@shared/analysis'
import type { Clip, MediaMeta } from '@shared/project'
import { FLICKS } from '@shared/time'
import { applyEdits, Ids } from './edits'
import { buildIndex, formatTranscript, searchTranscript, type Analyses, type TWord, type TSentence } from './transcript'

const S = (s: number) => Math.round(s * FLICKS)
const PATH = '/footage/talk.mp4'
// Source 100s..: "So, um, this is great. [1.5 s pause] Really great!"  plus applause and a shot cut.
const raw: [string, number, number, Partial<AnalysisWord>?][] = [
  ['So,', 100.0, 100.3], ['um,', 100.4, 100.7, { filler: true }], ['this', 100.8, 101.0], ['is', 101.05, 101.2], ['great.', 101.25, 101.7],
  ['Really', 103.2, 103.6, { db: 7.5 }], ['great!', 103.65, 104.1]
]
const analysis: SourceAnalysis = {
  version: 1, path: PATH, range: { start: S(90), end: S(120) }, language: 'en', parts: ['speech', 'events', 'tone', 'shots'], models: {},
  words: raw.map(([text, a, b, extra]) => ({ text, start: S(a), end: S(b), p: 0.9, ...extra })),
  sentences: [
    { start: S(100), end: S(101.7), words: [0, 5], text: 'So, um, this is great.' },
    { start: S(103.2), end: S(104.1), words: [5, 7], text: 'Really great!', tone: { label: 'happy', confidence: 0.8 } }
  ],
  events: [{ cue: 'APPLAUSE', label: 'Applause', start: S(104.3), end: S(106), score: 0.9 }],
  silences: [], shots: [S(102.5)]
}

/** Video + linked audio of the source, trimmed to source 99s..109s, placed at timeline 0. */
function editor() {
  const app = new CascadeApp('editor', null)
  const meta = { duration: S(600), hasAudio: true, hasVideo: true } as MediaMeta
  const clip = (id: string, type: string): Clip => ({ id, type, mediaId: 'm1', name: 'talk', start: 0, duration: S(10), sourceIn: S(99), properties: [], data: {}, linkId: 'L1' })
  app.doc.transact('setup', d => {
    d.media.m1 = { id: 'm1', type: 'video', name: 'talk.mp4', path: PATH, meta }
    d.mediaOrder.push('m1')
    const tl = d.timelines[d.activeTimeline]
    tl.tracks.find(t => t.kind === 'visual')!.clips.push(clip('cv', 'video'))
    tl.tracks.find(t => t.kind === 'audio')!.clips.push(clip('ca', 'audio'))
  })
  const analyses: Analyses = new Map([[PATH, [analysis]]])
  return { app, analyses }
}
const labels = (ids: Ids) => ({ wordId: (w: TWord) => ids.show(w.key, 'w'), sentenceId: (s: TSentence) => ids.show(s.key, 's'), clipLabel: (c: { id: string }) => ids.show(c.id, 'c'), trackLabel: (t: { id: string; name: string }) => t.name })
const words = (app: CascadeApp, analyses: Analyses) => buildIndex(app.project(), analyses).words.map(w => w.text)

test('maps source words into timeline time once per linked pair, with shots from the video', () => {
  const { app, analyses } = editor()
  const index = buildIndex(app.project(), analyses)
  expect(index.words).toHaveLength(7)
  expect(index.words[0].start).toBe(S(1))
  expect(index.words.every(w => w.clipId === 'ca')).toBe(true)
  expect(index.shots).toEqual([{ t: S(3.5), clipId: 'cv' }])
  expect(index.events[0]).toMatchObject({ cue: 'APPLAUSE', start: S(5.3), end: S(7) })
})

test('formats an interleaved, id-addressable transcript', () => {
  const { app, analyses } = editor()
  const ids = new Ids()
  const out = formatTranscript(buildIndex(app.project(), analyses), { fps: app.fps(), view: 'sentences', maxLines: 100, ...labels(ids) })
  expect(out).toContain('s1 00:00:01.00–00:00:02.21 w1–w5 So, {um,} this is great.')
  expect(out).toContain('⏸ 1.50s')
  expect(out).toContain('✂ 00:00:03.15')
  expect(out).toContain('s2 00:00:04.06–00:00:05.03 w6–w7 [happy .80] *Really* great!')
  expect(out).toContain('[APPLAUSE 00:00:05.09–00:00:07.00 .90]')
  // Chronological: pause, then the shot cut, then the next sentence.
  expect(out.indexOf('⏸')).toBeLessThan(out.indexOf('✂'))
  expect(out.indexOf('✂')).toBeLessThan(out.indexOf('s2 '))
})

test('search finds phrases across punctuation and returns word ranges', () => {
  const { app, analyses } = editor()
  const hits = searchTranscript(buildIndex(app.project(), analyses), 'really GREAT', false)
  expect(hits).toHaveLength(1)
  expect(hits[0].sentence.words.slice(hits[0].from, hits[0].to + 1).map(w => w.text)).toEqual(['Really', 'great!'])
})

test('cut_words removes words cleanly from video and audio, and ids re-resolve after earlier cuts', () => {
  const { app, analyses } = editor()
  const ids = new Ids()
  formatTranscript(buildIndex(app.project(), analyses), { fps: app.fps(), view: 'words', maxLines: 100, ...labels(ids) })
  const before = app.duration()
  // Cut the filler (w2), then the whole first sentence's tail "this is" (w3–w4) in the same batch.
  const result = applyEdits(app, { ops: [{ op: 'cut_words', from: 'w2' }, { op: 'cut_words', from: 'w3', to: 'w4' }] }, ids, analyses)
  expect(result).toContain('One undo step committed.')
  expect(words(app, analyses)).toEqual(['So,', 'great.', 'Really', 'great!'])
  expect(app.duration()).toBeLessThan(before)
  // Video and audio stay in sync: both tracks have identical clip layouts.
  const [v, a] = ['visual', 'audio'].map(k => app.timeline().tracks.find(t => t.kind === k && t.clips.length)!.clips.map(c => [c.start, c.duration, c.sourceIn]))
  expect(v).toEqual(a)
  // The first word's attack is untouched, and the kept pause before "um" is preserved.
  const idx = buildIndex(app.project(), analyses)
  expect(idx.words[0].start).toBe(S(1))
  expect(idx.words[1].start - idx.words[0].end).toBeGreaterThan(S(0.05))
})

test('remove_fillers and tighten_pauses batch into one undo step', () => {
  const { app, analyses } = editor()
  const out = applyEdits(app, { ops: [{ op: 'remove_fillers' }, { op: 'tighten_pauses', maxPause: S(0.5), keepEvents: true }] }, new Ids(), analyses)
  expect(out).toMatch(/remove_fillers: ok \(removed 1 range/)
  expect(out).toMatch(/tighten_pauses: ok \(removed 1 range/)
  const idx = buildIndex(app.project(), analyses)
  expect(idx.words.map(w => w.text)).not.toContain('um,')
  const gap = idx.words[5 - 1].start - idx.words[3].end // "great." → "Really"
  expect(gap).toBeLessThanOrEqual(S(0.55))
  app.doc.undo()
  expect(buildIndex(app.project(), analyses).words).toHaveLength(7)
})

test('cut_words rejects ids that were already cut', () => {
  const { app, analyses } = editor()
  const ids = new Ids()
  formatTranscript(buildIndex(app.project(), analyses), { fps: app.fps(), view: 'words', maxLines: 100, ...labels(ids) })
  expect(() => applyEdits(app, { ops: [{ op: 'cut_words', from: 'w2' }, { op: 'cut_words', from: 'w2' }] }, ids, analyses)).toThrow(/not in the current transcript/)
})
