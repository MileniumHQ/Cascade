import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { SourceAnalysis } from '@shared/analysis'
import { clipEnd, type MediaMeta } from '@shared/project'
import { FLICKS } from '@shared/time'
import { easingsPlugin } from '../easings'
import { videoPlugin } from '../media/video'
import { audioPlugin } from '../media/audio'
import { elementPlugin } from '../media/element'
import { timePropertiesPlugin } from '../properties/time'
import { audioPropertiesPlugin } from '../properties/audio'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { applyEdits, Ids, type ApplyOptions } from './edits'
import { findSpoken, buildIndex, type Analyses } from './transcript'

const S = (s: number) => Math.round(s * FLICKS)
const TALK = '/footage/talk.mp4', SONG = '/footage/song.wav', OTHER = '/footage/other.mp4'
// talk.mp4 at source 0: "So um this is great" 1.0–2.7 s, "Really great" 4.2–5.1 s.
const said: [string, number, number][] = [['So,', 1, 1.3], ['um,', 1.4, 1.7], ['this', 1.8, 2], ['is', 2.05, 2.2], ['great.', 2.25, 2.7], ['Really', 4.2, 4.6], ['great!', 4.65, 5.1]]
const analysis: SourceAnalysis = {
  version: 1, path: TALK, range: { start: 0, end: S(60) }, language: 'en', parts: ['speech'], models: {},
  words: said.map(([text, a, b]) => ({ text, start: S(a), end: S(b), p: 0.9 })),
  sentences: [{ start: S(1), end: S(2.7), words: [0, 5], text: 'So, um, this is great.' }, { start: S(4.2), end: S(5.1), words: [5, 7], text: 'Really great!' }],
  events: [], silences: [], shots: []
}

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([easingsPlugin, videoPlugin, audioPlugin, elementPlugin, timePropertiesPlugin, audioPropertiesPlugin, visualPropertiesPlugin, textPropertiesPlugin].map(def => ({ def, builtin: true })))
  app.doc.transact('Fixture', d => {
    d.media.talk = { id: 'talk', type: 'video', name: 'talk.mp4', path: TALK, meta: { duration: S(60), hasAudio: true, hasVideo: true } as MediaMeta }
    d.media.other = { id: 'other', type: 'video', name: 'other.mp4', path: OTHER, meta: { duration: S(60), hasAudio: false, hasVideo: true } as MediaMeta }
    d.media.song = { id: 'song', type: 'audio', name: 'song.wav', path: SONG, meta: { duration: S(120), hasAudio: true } as MediaMeta }
    d.mediaOrder.push('talk', 'other', 'song')
  })
  const ids = new Ids(), analyses: Analyses = new Map([[TALK, [analysis]]])
  // Refs only live within a batch; remember the aliases they got so later batches can use the names.
  const named = new Map<string, string>()
  const alias = (v: unknown): unknown => typeof v === 'string' ? named.get(v) ?? v : Array.isArray(v) ? v.map(alias) : v
  const edit = (ops: Record<string, unknown>[], options: ApplyOptions = {}) => {
    const out = applyEdits(app, { ops: ops.map(op => Object.fromEntries(Object.entries(op).map(([k, v]) => [k, k === 'ref' ? v : alias(v)]))) }, ids, analyses, options)
    for (const [, id, ref] of out.matchAll(/\b([ct]\d+) \(([\w.]+)\)/g)) named.set(ref, id)
    return out
  }
  const clip = (ref: string) => app.timeline().tracks.flatMap(t => t.clips).find(c => c.id === ids.resolve(named.get(ref) ?? ref))!
  const track = (ref: string) => app.timeline().tracks.find(t => t.clips.some(c => c.id === clip(ref).id))!
  return { app, ids, edit, clip, track, analyses }
}

test('duplicate_clip copies a linked pair with fresh ids; replace_clip swaps the source and drops audio the new one lacks', async () => {
  const { app, edit, clip, track } = await editor()
  const out = edit([
    { op: 'add_clip', mediaId: 'talk', start: 0, duration: S(3), ref: 'v' },
    { op: 'duplicate_clip', clipId: 'v', ref: 'copy' }
  ])
  expect(out).toMatch(/duplicate_clip: ok c\d+ \(copy\) \+ linked c\d+/)
  const copy = clip('copy')
  expect(copy.start).toBe(S(3))
  expect(copy.linkId && copy.linkId !== clip('v').linkId).toBe(true)
  const audio = app.timeline().tracks.flatMap(t => t.clips).filter(c => c.linkId === copy.linkId)
  expect(audio.map(c => c.type).sort()).toEqual(['audio', 'video'])
  edit([{ op: 'replace_clip', clipId: copy.id, mediaId: 'other', sourceIn: '10s' }])
  expect(clip(copy.id)).toMatchObject({ mediaId: 'other', sourceIn: S(10), start: S(3), name: 'other.mp4' })
  expect(app.timeline().tracks.flatMap(t => t.clips).filter(c => c.linkId === copy.linkId)).toHaveLength(1)
  expect(track(copy.id).kind).toBe('visual')
})

test('merge_tracks moves clips onto one track and removes the emptied ones', async () => {
  const { app, edit, clip, track } = await editor()
  edit([
    { op: 'add_track', kind: 'visual', ref: 'a' }, { op: 'add_track', kind: 'visual', ref: 'b' },
    { op: 'add_text', text: 'one', start: 0, duration: S(2), trackId: 'a', ref: 'one' },
    { op: 'add_text', text: 'two', start: S(3), duration: S(2), trackId: 'b', ref: 'two' }
  ])
  const before = app.timeline().tracks.length, into = track('one').id
  edit([{ op: 'merge_tracks', trackIds: [track('two').id], into }])
  expect(app.timeline().tracks).toHaveLength(before - 1)
  expect(track('two').id).toBe(into)
  expect(clip('two').start).toBe(S(3))
})

test('duck dips music volume under transcribed speech with attack and release', async () => {
  const { edit, clip } = await editor()
  edit([{ op: 'add_clip', mediaId: 'talk', start: 0, duration: S(8) }, { op: 'add_track', kind: 'audio', ref: 'bed' }, { op: 'add_clip', mediaId: 'song', start: 0, duration: S(8), trackId: 'bed', ref: 'music' }])
  const out = edit([{ op: 'duck', clipIds: ['music'], amount: -15 }])
  expect(out).toMatch(/volume keyframes under 2 speech segments/)
  const gain = clip('music').properties.find(p => p.type === 'volume')!.params.gain
  const keys = gain.keyframes!.map(k => [Math.round(k.t / FLICKS * 1000) / 1000, k.value])
  expect(keys).toEqual([[0.85, 0], [1, -15], [2.7, -15], [3.1, 0], [4.05, 0], [4.2, -15], [5.1, -15], [5.5, 0]])
  expect(() => edit([{ op: 'duck', clipIds: ['music'] }])).toThrow(/already has volume keyframes/)
})

test('snap_to_beats moves clip starts to the nearest beat within maxShift', async () => {
  const { edit, clip } = await editor()
  edit([
    { op: 'add_clip', mediaId: 'song', start: S(1), duration: S(10), ref: 'music' },
    { op: 'add_text', text: 'near', start: S(2.1), duration: S(1), ref: 'near' },
    { op: 'add_text', text: 'far', start: S(4.5), duration: S(1), ref: 'far' }
  ])
  // Beats every second of source from 0; the clip starts at source 0 at timeline 1 s.
  const beats = new Map([[SONG, { beats: Array.from({ length: 12 }, (_, i) => S(i)), downbeats: [0, S(4), S(8)] }]])
  expect(() => edit([{ op: 'snap_to_beats', clipIds: ['near'], beatClipId: 'music' }])).toThrow(/run beat_grid/)
  const out = edit([{ op: 'snap_to_beats', clipIds: ['near', 'far'], beatClipId: 'music' }], { beats })
  expect(out).toMatch(/1 clips to beats, 1 left alone/)
  expect(clip('near').start).toBe(S(2))
  expect(clip('far').start).toBe(S(4.5))
  edit([{ op: 'snap_to_beats', clipIds: ['far'], beatClipId: 'music', to: 'downbeats', maxShift: '1s' }], { beats })
  expect(clip('far').start).toBe(S(5))
})

test('sync_text retimes text clips to when their words are spoken', async () => {
  const { app, edit, clip, analyses } = await editor()
  edit([
    { op: 'add_clip', mediaId: 'talk', start: 0, duration: S(8) },
    { op: 'add_track', kind: 'visual', ref: 'cap' },
    { op: 'add_text', text: 'Really great', start: S(3), duration: S(4), trackId: 'cap', ref: 'line' }
  ])
  edit([{ op: 'sync_text', clipIds: ['line'], padding: '100ms' }])
  expect(clip('line').start).toBe(S(4.1))
  expect(clipEnd(clip('line'))).toBe(S(5.2))
  edit([{ op: 'add_text', text: 'Never said', start: 0, duration: S(1), trackId: 'cap', ref: 'n' }])
  expect(() => edit([{ op: 'sync_text', clipIds: ['n'] }])).toThrow(/not in the transcript/)
  // The matcher tolerates a filler between script words.
  const words = buildIndex(app.project(), analyses).words
  expect(findSpoken(words, 'So this is great')).toEqual([[0, 4]])
})
