import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { Clip, MediaMeta } from '@shared/project'
import { FLICKS } from '@shared/time'
import { easingsPlugin } from '../plugins/builtin/easings'
import { audioPlugin } from '../plugins/builtin/media/audio'
import { videoPlugin } from '../plugins/builtin/media/video'
import { timePropertiesPlugin } from '../plugins/builtin/properties/time'
import { audioPropertiesPlugin } from '../plugins/builtin/properties/audio'
import { audioPlan } from '../plugins/builtin/export-request'
import { constantMap, curveMap, sourceSpan } from './time-remap'

const S = (s: number) => Math.round(s * FLICKS)
const near = (a: number, b: number, tol = FLICKS / 1000) => expect(Math.abs(a - b)).toBeLessThan(tol)

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([easingsPlugin, videoPlugin, audioPlugin, timePropertiesPlugin, audioPropertiesPlugin].map((def) => ({ def, builtin: true })))
  const meta = { duration: S(600), hasAudio: true, hasVideo: true } as MediaMeta
  const clip = (id: string, type: string): Clip => ({ id, type, mediaId: 'm1', name: 'clip', start: S(10), duration: S(10), sourceIn: S(100), properties: [], data: {}, linkId: 'L1' })
  app.doc.transact('setup', (d) => {
    d.media.m1 = { id: 'm1', type: 'video', name: 'clip.mp4', path: '/x.mp4', meta }
    const tl = d.timelines[d.activeTimeline]
    tl.tracks.find((t) => t.kind === 'visual')!.clips.push(clip('cv', 'video'))
    tl.tracks.find((t) => t.kind === 'audio')!.clips.push(clip('ca', 'audio'))
  })
  return app
}

test('constant map scales and inverts', () => {
  const m = constantMap(2)
  expect(m.offset(S(3))).toBe(S(6))
  expect(m.localAt(S(6))).toBe(S(3))
})

test('linear speed ramp integrates exactly and inverts', async () => {
  const app = await editor()
  // 1× → 3× over 2 s, linear: offset(2s) = 4 s, then 3×.
  const m = curveMap(1, [{ id: 'a', t: 0, value: 1, easing: { id: 'linear' } }, { id: 'b', t: S(2), value: 3, easing: { id: 'linear' } }], app.registries)
  expect(m.constant).toBeNull()
  near(m.offset(S(1)), S(1.5))
  near(m.offset(S(2)), S(4))
  near(m.offset(S(3)), S(7))
  near(m.localAt(S(1.5)), S(1))
  near(m.localAt(S(7)), S(3))
  expect(m.speedAt(S(1))).toBeCloseTo(2)
  expect([m.min, m.max]).toEqual([1, 3])
})

test('speed edits go to the Speed property of the picture; linked audio follows', async () => {
  const app = await editor()
  app.edit.updateClip('ca', { speed: 2 })
  const tl = app.timeline()
  const video = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === 'cv')!
  const audio = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === 'ca')!
  expect(video.properties.find((p) => p.type === 'speed')?.params.speed.value).toBe(2)
  expect(audio.properties.some((p) => p.type === 'speed')).toBe(false)
  expect(app.edit.timeMap('ca').constant).toBe(2)
  expect(app.edit.timeMap('cv').constant).toBe(2)
  app.doc.undo()
  expect(app.edit.timeMap('ca').constant).toBe(1)
})

test('trimming the start of a sped-up linked pair advances both sources by the integral', async () => {
  const app = await editor()
  app.edit.updateClip('cv', { speed: 2 })
  app.edit.trimClip('cv', 'start', S(12))
  const clips = app.timeline().tracks.flatMap((t) => t.clips)
  for (const c of clips) {
    expect(c.start).toBe(S(12))
    expect(c.sourceIn).toBe(S(104))
  }
})

test('unlink keeps the audio at the speed it was following', async () => {
  const app = await editor()
  app.edit.updateClip('cv', { speed: 1.5 })
  app.edit.unlink(['cv'])
  expect(app.edit.timeMap('ca').constant).toBe(1.5)
})

test('export plan: time-stretch by default, resample when pitch follows speed', async () => {
  const app = await editor()
  const range = { start: 0, end: S(30) }
  expect(audioPlan(app, range).ca.mode).toBe('source')
  app.edit.updateClip('cv', { speed: 2 })
  const stretch = audioPlan(app, range).ca
  expect(stretch).toMatchObject({ mode: 'stretch', tempo: 2, pitch: 1, localStart: 0, sourceStart: 100, sourceEnd: 120 })
  const pitch = app.edit.addProperty('ca', 'pitch')!
  app.edit.setParam('ca', pitch, 'matchSpeed', true)
  expect(audioPlan(app, range).ca.mode).toBe('source')
  app.edit.setParam('ca', pitch, 'semitones', 12)
  expect(audioPlan(app, range).ca).toMatchObject({ mode: 'stretch', tempo: 2, pitch: 4 })
})

test('reverse: the pair plays its source range backwards; split, trim limits and export plan agree', async () => {
  const app = await editor()
  // 10 s at 2×, backwards from 100 s: uses source 80–100 s.
  app.edit.updateClip('cv', { speed: 2 })
  const prop = app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === 'cv')!.properties.find((p) => p.type === 'speed')!
  app.edit.setParam('cv', prop.id, 'reverse', true)
  for (const id of ['cv', 'ca']) {
    const m = app.edit.timeMap(id)
    expect(m.reversed).toBe(true)
    expect(m.offset(S(10))).toBe(-S(20))
    expect(m.localAt(-S(20))).toBe(S(10))
  }
  const audioClip = () => app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === 'ca')!
  expect(sourceSpan(audioClip(), app.edit.timeMap('ca'))).toEqual({ lo: S(80), hi: S(100) })
  const plan = audioPlan(app, { start: 0, end: S(30) }).ca
  expect(plan).toMatchObject({ mode: 'stretch', reverse: true, tempo: 2, sourceStart: 80, sourceEnd: 100 })
  // Split at 15 s: the right half starts 10 s further down the source.
  const [right] = app.edit.splitAt(S(15), ['cv'])!
  expect(app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === right)!.sourceIn).toBe(S(90))
  // Extending the start is limited by the source end (600 s), the end by source 0.
  app.edit.trimClip('cv', 'start', 0)
  expect(audioClip().start).toBe(0)
  expect(audioClip().sourceIn).toBe(S(120))
  app.edit.trimClip(right, 'end', S(500))
  const r = app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === right)!
  expect(r.sourceIn + app.edit.timeMap(r).offset(r.duration)).toBe(0)
})

test('transition handles extrapolate at clip boundary speeds, with inverse and reverse symmetry', async () => {
  const { extendMap, reverseMap } = await import('./time-remap')
  const app = await editor()
  // Curve continues beyond a clip trimmed to 1 s; the handle must stay at its 2× boundary speed.
  const raw = curveMap(1, [{ id: 'a', t: 0, value: 1, easing: { id: 'linear' } }, { id: 'b', t: S(2), value: 3, easing: { id: 'linear' } }], app.registries)
  const m = extendMap(raw, S(1))
  near(m.offset(-S(1)), -S(1))
  near(m.offset(S(2)), S(3.5))
  expect(m.speedAt(S(2))).toBe(2)
  const reversed = extendMap(reverseMap(raw), S(1))
  for (const t of [-S(1), 0, S(0.5), S(1), S(2)]) {
    near(m.localAt(m.offset(t)), t)
    near(reversed.offset(t), -m.offset(t))
    near(reversed.localAt(reversed.offset(t)), t)
  }
})

test('retained keyframes before a split/trim keep offset zero at local zero', async () => {
  const { extendMap } = await import('./time-remap')
  const app = await editor()
  const m = extendMap(curveMap(1, [{ id: 'a', t: -S(1), value: 1, easing: { id: 'linear' } }, { id: 'b', t: S(1), value: 3, easing: { id: 'linear' } }], app.registries), S(0.5))
  expect(m.offset(0)).toBe(0)
  near(m.offset(S(0.5)), S(1.125))
  near(m.offset(-S(0.5)), -S(1))
  near(m.localAt(S(1.125)), S(0.5))
})

test('source availability covers forward and reversed handles', async () => {
  const { reverseMap, sourceLocalRange } = await import('./time-remap')
  const app = await editor()
  const clip = app.timeline().tracks[0].clips[0]
  expect(sourceLocalRange(clip, constantMap(2), S(120))).toEqual({ start: -S(50), end: S(10) })
  expect(sourceLocalRange(clip, reverseMap(constantMap(2)), S(120))).toEqual({ start: -S(10), end: S(50) })
})

test('extending a trimmed ramp uses the retained curve for source limits', async () => {
  const app = await editor()
  app.doc.transact('short source and retained ramp', d => {
    d.media.m1.meta.duration = S(3)
    for (const tr of d.timelines[d.activeTimeline].tracks) for (const c of tr.clips) {
      c.sourceIn = 0
      c.duration = S(1)
      c.properties = c.id === 'cv' ? [{ id: 'rate', type: 'speed', enabled: true, params: {
        speed: { value: 1, keyframes: [{ id: 'k0', t: 0, value: 1, easing: { id: 'linear' } }, { id: 'k1', t: S(2), value: 3, easing: { id: 'linear' } }] }
      } }] : []
    }
  })
  app.edit.trimClip('cv', 'end', S(12))
  const c = app.timeline().tracks[0].clips[0]
  expect(app.edit.timeMap(c).offset(c.duration)).toBeLessThanOrEqual(S(3) + 2)
  near(c.duration, S(Math.sqrt(7) - 1))
})

test('frozen time-map caches are active immediately after constructor and load', async () => {
  const original = await editor()
  for (const load of [false, true]) {
    const app = new CascadeApp('editor', null, original.project())
    if (load) app.doc.load(original.project())
    expect(app.edit.timeMap('cv')).toBe(app.edit.timeMap('cv'))
  }
})
