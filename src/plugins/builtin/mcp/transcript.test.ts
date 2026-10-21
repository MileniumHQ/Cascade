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
  ['Really', 103.2, 103.6, { db: 3, st: 4, emphasis: true }], ['great!', 103.65, 104.1, { db: -1, st: 1.2 }]
]
const analysis: SourceAnalysis = {
  version: 1, path: PATH, range: { start: S(90), end: S(120) }, language: 'en', parts: ['speech', 'events', 'prosody', 'shots'], models: {},
  words: raw.map(([text, a, b, extra]) => ({ text, start: S(a), end: S(b), p: 0.9, ...extra })),
  sentences: [
    { start: S(100), end: S(101.7), words: [0, 5], text: 'So, um, this is great.', pitch: { range: 4, end: 'fall' } },
    { start: S(103.2), end: S(104.1), words: [5, 7], text: 'Really great!', pitch: { range: 9, end: 'rise' } },
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
  expect(out).toContain('⏸ 1.50s w5.end → w6.start')
  expect(out).toContain('✂ 00:00:03.15')
  expect(out).toContain('s2 00:00:04.06–00:00:05.03 w6–w7 [lively] ↗ *Really* great!')
  expect(out).toContain('[APPLAUSE 00:00:05.09–00:00:07.00 .90]')
  // Chronological: pause, then the shot cut, then the next sentence.
  expect(out.indexOf('⏸')).toBeLessThan(out.indexOf('✂'))
  expect(out.indexOf('✂')).toBeLessThan(out.indexOf('s2 '))
})

test('the words view gives exact pitch and loudness per word', () => {
  const { app, analyses } = editor()
  const out = formatTranscript(buildIndex(app.project(), analyses), { fps: app.fps(), view: 'words', maxLines: 100, ...labels(new Ids()) })
  expect(out).toContain('w6 00:00:04.06–00:00:04.18 *Really* +4.0st +3.0dB')
  expect(out).toContain('w7 00:00:04.19–00:00:05.03 great! +1.2st -1.0dB')
})

test('search finds phrases across punctuation and returns word ranges', () => {
  const { app, analyses } = editor()
  const hits = searchTranscript(buildIndex(app.project(), analyses), 'really GREAT', false)
  expect(hits).toHaveLength(1)
  expect(hits[0].sentence.words.slice(hits[0].from, hits[0].to + 1).map(w => w.text)).toEqual(['Really', 'great!'])
})

const transcriptIds = (app: CascadeApp, analyses: Analyses) => {
  const ids = new Ids()
  formatTranscript(buildIndex(app.project(), analyses), { fps: app.fps(), view: 'words', maxLines: 100, ...labels(ids) })
  return ids
}

test('ripple_delete by anchors composes word cuts; anchors re-resolve after earlier ops in the batch', () => {
  const { app, analyses } = editor()
  const ids = transcriptIds(app, analyses)
  const before = app.duration()
  // Remove the filler (w2), then "this is" (w3–w4); the second op's anchors see the first cut.
  const result = applyEdits(app, { ops: [
    { op: 'ripple_delete', start: 'w2.start-30ms', end: 'w3.start-60ms' },
    { op: 'ripple_delete', start: 'w3.start-30ms', end: 'w5.start-30ms' }
  ] }, ids, analyses)
  expect(result).toContain('One undo step committed.')
  expect(words(app, analyses)).toEqual(['So,', 'great.', 'Really', 'great!'])
  expect(app.duration()).toBeLessThan(before)
  // Video and audio stay in sync: both tracks have identical clip layouts.
  const [v, a] = ['visual', 'audio'].map(k => app.timeline().tracks.find(t => t.kind === k && t.clips.length)!.clips.map(c => [c.start, c.duration, c.sourceIn]))
  expect(v).toEqual(a)
  // The first word is untouched; the anchors' padding kept a small natural gap.
  const idx = buildIndex(app.project(), analyses)
  expect(idx.words[0].start).toBe(S(1))
  expect(idx.words[1].start - idx.words[0].end).toBeGreaterThan(S(0.05))
})

test('anchors work for any time field: markers and splits land on words', () => {
  const { app, analyses } = editor()
  const ids = transcriptIds(app, analyses)
  applyEdits(app, { ops: [{ op: 'add_marker', time: 's2.start', name: 'Reaction' }, { op: 'split', clipId: 'ca', time: 'w5.end+100ms' }, { op: 'add_marker', time: 's2.start+3f', name: 'Frames' }] }, ids, analyses)
  expect(app.timeline().markers.map(m => m.t)).toEqual([S(4.2), S(4.2) + 3 * Math.round(FLICKS / 30)])
  expect(app.timeline().tracks.find(t => t.kind === 'audio')!.clips.map(c => c.start)).toContain(S(2.8))
})

test('cut then act in one batch: an anchor on a cut clip lands on the piece holding the word', () => {
  const { app, analyses } = editor()
  const ids = transcriptIds(app, analyses)
  ids.show('ca', 'c')
  const result = applyEdits(app, { ops: [
    { op: 'ripple_delete', start: 'w5.end+80ms', end: 'w6.start-80ms' },
    { op: 'split', clipId: 'c1', time: 'w6.end' }
  ] }, ids, analyses)
  expect(result).toMatch(/2\. split: ok c\d+, on c1 → c\d+ \(piece holding w6.end\)/)
  const audio = app.timeline().tracks.find(t => t.kind === 'audio')!.clips
  const w6 = buildIndex(app.project(), analyses).words[5]
  expect(audio.map(c => c.start)).toContain(w6.end)
  expect(audio).toHaveLength(3)
  // A time outside every piece of that source is still an error.
  expect(() => applyEdits(app, { ops: [{ op: 'split', clipId: 'c1', time: 'w7.end+20s' }] }, ids, analyses)).toThrow(/outside clip c1/)
})

test('anchors that were cut are rejected and nothing is applied', () => {
  const { app, analyses } = editor()
  const ids = transcriptIds(app, analyses)
  const before = app.project()
  expect(() => applyEdits(app, { ops: [
    { op: 'ripple_delete', start: 'w2.start', end: 'w2.end' },
    { op: 'ripple_delete', start: 'w2.start', end: 'w3.end' }
  ] }, ids, analyses)).toThrow(/not on the timeline/)
  expect(app.project()).toBe(before)
})

test('repeated placements of the same words get distinct ids', () => {
  const { app, analyses } = editor()
  app.doc.transact('repeat', d => {
    const tl = d.timelines[d.activeTimeline]
    tl.tracks.find(t => t.kind === 'audio')!.clips.push({ id: 'again', type: 'audio', mediaId: 'm1', name: 'talk', start: S(20), duration: S(2), sourceIn: S(99.9), properties: [], data: {} })
  })
  const index = buildIndex(app.project(), analyses)
  const so = index.words.filter(w => w.text === 'So,')
  expect(so).toHaveLength(2)
  expect(new Set(so.map(w => w.key)).size).toBe(2)
  expect(new Set(index.sentences.map(s => s.key)).size).toBe(index.sentences.length)
})
