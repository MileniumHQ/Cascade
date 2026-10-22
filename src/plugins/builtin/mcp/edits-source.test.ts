import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { SourceAnalysis } from '@shared/analysis'
import type { MediaMeta } from '@shared/project'
import { FLICKS, frameToFlicks } from '@shared/time'
import { easingsPlugin } from '../easings'
import { videoPlugin } from '../media/video'
import { audioPlugin } from '../media/audio'
import { elementPlugin } from '../media/element'
import { timePropertiesPlugin } from '../properties/time'
import { audioPropertiesPlugin } from '../properties/audio'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { applyEdits, Ids } from './edits'
import { buildSourceIndex, formatTranscript, SOURCE_LEGEND, type Analyses } from './transcript'

const S = (s: number) => Math.round(s * FLICKS)
const PATH = '/footage/talk.mp4'
const words: [string, number, number][] = [['So,', 100.0, 100.3], ['this', 100.8, 101.0], ['is', 101.05, 101.2], ['great.', 101.25, 101.7], ['Really', 103.2, 103.6], ['great!', 103.65, 104.1]]
const analysis: SourceAnalysis = {
  version: 1, path: PATH, range: { start: S(90), end: S(120) }, language: 'en', parts: ['speech', 'shots'], models: {},
  words: words.map(([text, a, b]) => ({ text, start: S(a), end: S(b), p: 0.9 })),
  sentences: [{ start: S(100), end: S(101.7), words: [0, 4], text: 'So, this is great.' }, { start: S(103.2), end: S(104.1), words: [4, 6], text: 'Really great!' }],
  events: [], silences: [], shots: [S(102.5)]
}

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([easingsPlugin, videoPlugin, audioPlugin, elementPlugin, timePropertiesPlugin, audioPropertiesPlugin, visualPropertiesPlugin, textPropertiesPlugin].map(def => ({ def, builtin: true })))
  app.doc.transact('Fixture', d => {
    d.media.src = { id: 'src', type: 'video', name: 'talk.mp4', path: PATH, meta: { duration: S(600), hasAudio: true, hasVideo: true } as MediaMeta }
    d.mediaOrder.push('src')
  })
  const ids = new Ids()
  ids.show('src', 'm')
  const analyses: Analyses = new Map([[PATH, [analysis]]])
  return { app, ids, analyses }
}
const clips = (app: CascadeApp) => app.timeline().tracks.flatMap(t => t.clips)
const clip = (app: CascadeApp, id: string) => clips(app).find(c => c.id === id)!

test('source transcript: positional m1:w#/m1:s# ids in source time, with word end times', async () => {
  const { app, ids, analyses } = await editor()
  const index = buildSourceIndex('src', analyses.get(PATH))
  const out = formatTranscript(index, { legend: SOURCE_LEGEND, fps: app.fps(), view: 'words', maxLines: 100, wordId: w => `m1:w${index.wordNo.get(w)}`, sentenceId: s => `m1:s${index.sentenceNo.get(s)}`, clipLabel: () => '', trackLabel: () => '' })
  expect(out).toContain('m1:s2 00:01:43.200–00:01:44.100 m1:w5–m1:w6')
  expect(out).toContain('m1:w5 00:01:43.200–00:01:43.600 Really')
  expect(out).toContain('✂ 00:01:42.500')
  expect(ids.resolve('m1')).toBe('src')
})

test('add_clip by source anchors and speed derives the duration, links audio, and appends', async () => {
  const { app, ids, analyses } = await editor()
  const result = applyEdits(app, { ops: [
    // "Really great!" at 2×, then the first sentence appended after it.
    { op: 'add_clip', mediaId: 'm1', start: 0, sourceIn: 'm1:w5.start', sourceOut: 'm1:s2.end', speed: 2, ref: 'a' },
    { op: 'add_clip', mediaId: 'm1', sourceIn: 'm1:s1', sourceOut: 'm1:s1.end+100ms', ref: 'b' },
    { op: 'set_param', clipId: 'b.audio', propertyId: 'volume', paramId: 'gain', value: 6 }
  ] }, ids, analyses)
  expect(result).toMatch(/1\. add_clip: ok c\d+ \(a\) \[0, \d+\) \+ linked audio c\d+ \(a\.audio\)/)
  const fps = app.fps()
  const frames = (d: number) => frameToFlicks(Math.floor(d * fps.num / (FLICKS * fps.den)), fps)
  const [va, vb] = app.timeline().tracks.find(t => t.kind === 'visual')!.clips
  const [aa, ab] = app.timeline().tracks.find(t => t.kind === 'audio')!.clips
  expect(va.duration).toBe(frames((S(104.1) - S(103.2)) / 2))
  expect(va.sourceIn).toBe(S(103.2))
  expect(vb.start).toBe(va.duration)
  expect(vb.duration).toBe(frames(S(1.8)))
  expect([aa.linkId, ab.linkId]).toEqual([va.linkId, vb.linkId])
  // Speed is on the picture clip; its audio follows.
  expect(app.edit.timeMap(aa).constant).toBe(2)
  expect(app.edit.timeMap(ab).constant).toBe(1)
  expect(ab.properties.find(p => p.type === 'volume')!.params.gain.value).toBe(6)
})

test('repeat, reverse and refs; speed edits on the audio go to the pair', async () => {
  const { app, ids, analyses } = await editor()
  const result = applyEdits(app, { ops: [
    { op: 'add_clip', mediaId: 'm1', start: S(1), sourceIn: S(100), sourceOut: S(100.5), repeat: 3, ref: 's' },
    { op: 'add_clip', mediaId: 'm1', sourceIn: S(100), sourceOut: S(101), reverse: true, ref: 'r' },
    { op: 'add_property', clipId: 's.2.audio', type: 'speed' },
    { op: 'set_param', clipId: 's.2.audio', propertyId: 'speed', paramId: 'speed', value: 0.5 },
    { op: 'set_param', clipId: 's.3.audio', propertyId: 'speed', paramId: 'speed', value: 0.8 }
  ] }, ids, analyses)
  expect(result).toContain('(s.3)')
  expect(result).toContain('(s.2.audio)')
  expect(result).toMatch(/add_property: ok p\d+ \(on linked c\d+; speed applies to both\)/)
  const visual = app.timeline().tracks.find(t => t.kind === 'visual')!.clips
  expect(visual.map(c => c.start)).toEqual([S(1), S(1.5), S(2), S(2.5)])
  expect(visual.every(c => c.properties.filter(p => p.type === 'speed').length <= 1)).toBe(true)
  const audio = app.timeline().tracks.find(t => t.kind === 'audio')!.clips
  expect(audio.every(c => !c.properties.some(p => p.type === 'speed'))).toBe(true)
  expect(app.edit.timeMap(audio[1]).constant).toBe(0.5)
  expect(app.edit.timeMap(visual[2]).constant).toBe(0.8)
  // The reversed pair starts at the end of its range and runs down to sourceIn.
  const reversed = audio[3]
  expect(reversed.sourceIn).toBe(S(101))
  expect(app.edit.timeMap(reversed).reversed).toBe(true)
  expect(reversed.sourceIn + app.edit.timeMap(reversed).offset(reversed.duration)).toBe(S(100))
})

test('wiggle and add_keyframes write keyframes; fonts must be installed; source anchors are not timeline times', async () => {
  const { app, ids, analyses } = await editor()
  applyEdits(app, { ops: [
    { op: 'add_text', text: 'Hi', start: 0, duration: S(2), ref: 't' },
    { op: 'wiggle', clipId: 't', propertyId: 'transform', paramId: 'position', amplitude: [0.02, 0.01], frequency: 10, seed: 7 },
    { op: 'add_keyframes', clipId: 't', propertyId: 'opacity', paramId: 'opacity', keys: [{ time: 0, value: 0 }, { time: S(0.5), value: 1, easing: 'linear' }] }
  ] }, ids, analyses, { fonts: ['Inter', 'Comic Neue'] })
  const text = clips(app)[0]
  const keys = text.properties.find(p => p.type === 'transform')!.params.position.keyframes!
  expect(keys).toHaveLength(21)
  expect(keys[0].value).toEqual([0, 0])
  expect(keys.at(-1)!.value).toEqual([0, 0])
  expect(keys.slice(1, -1).every(k => Math.abs((k.value as number[])[0]) <= 0.02 && Math.abs((k.value as number[])[1]) <= 0.01)).toBe(true)
  expect(text.properties.find(p => p.type === 'opacity')!.params.opacity.keyframes).toHaveLength(2)
  const fontParam = app.registries.properties.get('text')!.params.find(p => p.type === 'font')!
  expect(() => applyEdits(app, { ops: [{ op: 'set_param', clipId: text.id, propertyId: 'text', paramId: fontParam.id, value: 'Comic Sans MS' }] }, ids, analyses, { fonts: ['Inter', 'Comic Neue'] })).toThrow(/not installed; similar: Comic Neue/)
  expect(() => applyEdits(app, { ops: [{ op: 'split', clipId: text.id, time: 'm1:w2' }] }, ids, analyses)).toThrow(/or an anchor like w12/)
  expect(clip(app, text.id).duration).toBe(S(2))
})
