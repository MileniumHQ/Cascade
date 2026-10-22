import { describe, expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { Clip, Track, TransitionInstance } from '@shared/project'
import { FLICKS } from '@shared/time'
import { transitionsPlugin } from '../plugins/builtin/transitions'
import { crossfadeGains, transitionProgress, visualTransitions } from '../plugins/builtin/transitions/effects'
import { clipRenderRange, transitionGain } from './transitions'
import { audioPlan, rangeHasAudio } from '../plugins/builtin/export-request'
import { timePropertiesPlugin } from '../plugins/builtin/properties/time'

const S = (n: number) => Math.round(n * FLICKS)
const clip = (id: string, start: number): Clip => ({ id, type: 'custom-audio', mediaId: 'm', name: id, start: S(start), duration: S(4), sourceIn: S(10), properties: [], data: {} })
const tx = (patch: Partial<TransitionInstance> = {}): TransitionInstance => ({ id: 'tx', type: 'audio-crossfade', from: 'a', to: 'b', duration: S(2), align: 'center', params: {}, ...patch })
const track = (): Track => ({ id: 'a1', kind: 'audio', name: 'A1', hidden: false, muted: false, locked: false, clips: [clip('a', 0), clip('b', 4)], transitions: [tx()] })
async function editor() {
  const app = new CascadeApp('render', null)
  const host = new PluginHost(app)
  await host.activate(transitionsPlugin, true)
  await host.activate(timePropertiesPlugin, true)
  app.doc.transact('setup', d => {
    d.media.m = { id: 'm', type: 'custom-audio', name: 'sound', path: '/test.wav', meta: { duration: S(30), hasAudio: true } }
    d.timelines[d.activeTimeline].tracks = [track()]
  })
  return app
}

describe('audio gains and ranges', () => {
  test('equal-power, linear and exponential endpoints and midpoint', () => {
    for (const curve of ['equal-power', 'linear', 'exponential']) {
      expect(crossfadeGains(0, { curve }).from).toBe(1)
      expect(crossfadeGains(0, { curve }).to).toBe(0)
      expect(crossfadeGains(1, { curve }).from).toBeCloseTo(0)
      expect(crossfadeGains(1, { curve }).to).toBe(1)
    }
    const mid = crossfadeGains(0.5, {})
    expect(mid.from ** 2 + mid.to ** 2).toBeCloseTo(1)
    expect(crossfadeGains(0.5, { curve: 'linear' })).toEqual({ from: 0.5, to: 0.5 })
    expect(crossfadeGains(0.5, { curve: 'exponential' })).toEqual({ from: 0.25, to: 0.25 })
  })
  test('easing is resolved in the plugin, with clamped endpoints', () => {
    for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out']) {
      expect(transitionProgress(-1, { easing })).toBe(0)
      expect(transitionProgress(2, { easing })).toBe(1)
    }
    expect(transitionProgress(0.25, { easing: 'ease-in' })).toBeCloseTo(0.0625)
    expect(transitionProgress(0.25, { easing: 'ease-out' })).toBeCloseTo(0.4375)
  })
  test('both sides are audible on either side of a cut, and gated outside the extended range', async () => {
    const app = await editor(), tr = app.timeline().tracks[0], [a, b] = tr.clips
    expect(clipRenderRange(app.registries, tr, b)).toEqual({ start: S(3), end: S(8) })
    expect(transitionGain(app.registries, tr, b, S(3.5))).toBeGreaterThan(0)
    expect(transitionGain(app.registries, tr, a, S(4.5))).toBeGreaterThan(0)
    expect(transitionGain(app.registries, tr, b, S(2.5))).toBe(0)
    expect(transitionGain(app.registries, tr, a, S(5))).toBe(0)
  })
  test('unknown or unsupported types neither extend clips nor alter gain', async () => {
    const app = await editor(), tr = track(), b = tr.clips[1]
    tr.transitions![0].type = 'missing'
    expect(clipRenderRange(app.registries, tr, b).start).toBe(S(4))
    expect(transitionGain(app.registries, tr, b, S(4))).toBe(1)
    tr.transitions![0].type = 'cross-dissolve'
    expect(clipRenderRange(app.registries, tr, b).start).toBe(S(4))
  })
  test('absent custom gain defaults to equal power; opposite fades multiply', async () => {
    const app = await editor(), tr = track(), a = tr.clips[0]
    app.registries.transitions.register({ id: 'third-party', name: 'Custom', description: '', icon: 'layers', kinds: ['audio'], params: [] }, 'custom', false)
    tr.transitions = [tx({ type: 'third-party', from: undefined, to: 'a', duration: S(4) }), tx({ id: 'out', type: 'third-party', to: undefined, duration: S(4) })]
    expect(transitionGain(app.registries, tr, a, S(2))).toBeCloseTo(0.5)
  })
  test('export plans include handles and source-limited reverse audio', async () => {
    const app = await editor()
    const plan = audioPlan(app, { start: 0, end: S(8) })
    expect(plan.a).toMatchObject({ sourceStart: 10, sourceEnd: 15 })
    expect(plan.b).toMatchObject({ sourceStart: 9, sourceEnd: 14 })
    expect(audioPlan(app, { start: S(3), end: S(3.5) }).b).toBeTruthy()
    app.edit.addProperty('b', 'speed')
    const prop = app.timeline().tracks[0].clips[1].properties[0]
    app.edit.setParam('b', prop.id, 'reverse', true)
    expect(audioPlan(app, { start: 0, end: S(8) }).b).toMatchObject({ mode: 'stretch', reverse: true, localStart: -1, sourceStart: 6, sourceEnd: 11 })
    app.doc.transact('no handles', d => { d.timelines[d.activeTimeline].tracks[0].clips[1].sourceIn = 0 })
    expect(audioPlan(app, { start: 0, end: S(8) }).b).toMatchObject({ localStart: -1, sourceStart: 0, sourceEnd: 1 })
    expect(rangeHasAudio(app, { start: S(3), end: S(3.5) })).toBe(true)
  })
})

test('built-in visuals are frame-relative and dissolve preserves full outgoing coverage', () => {
  const ctx = { id: 'tx', from: clip('a', 0), to: clip('b', 4), duration: S(2), mode: 'render' as const, project: new CascadeApp('render', null).project(), u: { x: (n: number) => `${n * 100}cqw`, y: (n: number) => `${n * 100}cqh`, len: (n: number) => `${n * 100}cqh`, frame: { width: 1920, height: 1080 } }, elements: { document: {} as Document } }
  for (const def of visualTransitions.filter(t => t.id !== 'dip-to-color')) {
    const values = Object.fromEntries(def.params.map(p => [p.id, p.default]))
    const out = def.apply!(0.5, values, ctx)
    expect(out?.from).toBeTruthy(); expect(out?.to).toBeTruthy()
    expect(JSON.stringify(out)).not.toMatch(/\dpx/)
  }
  const dissolve = visualTransitions.find(t => t.id === 'cross-dissolve')!
  expect(dissolve.apply!(0.5, {}, ctx)).toMatchObject({ from: { style: { opacity: '1' } }, to: { style: { opacity: '0.5' } } })
  expect(dissolve.apply!(0.5, {}, { ...ctx, to: undefined })).toMatchObject({ from: { style: { opacity: '0.5' } } })
})

test('transition range caches respect plugin hot reload and separate app registries', async () => {
  const { createRegistries } = await import('@core/app')
  const first = createRegistries(), second = createRegistries(), tr = Object.freeze(track()), b = tr.clips[1]
  const def = { id: 'audio-crossfade', name: 'Plugin', description: '', icon: 'layers', kinds: ['audio'] as ('visual' | 'audio')[], params: [] }
  first.transitions.register(def, 'one', false)
  second.transitions.register({ ...def, kinds: ['visual'] }, 'two', false)
  expect(clipRenderRange(first, tr, b).start).toBe(S(3))
  expect(clipRenderRange(second, tr, b).start).toBe(S(4))
  const hot = first.transitions.register({ ...def, kinds: ['visual'] }, 'one', false)
  expect(clipRenderRange(first, tr, b).start).toBe(S(4))
  hot.dispose()
  expect(clipRenderRange(first, tr, b).start).toBe(S(3))
})
