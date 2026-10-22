import { describe, expect, it } from 'vitest'
import { CascadeApp } from './app'
import { PluginHost } from './plugin-host'
import { clipEnd, findClip, type Clip, type PropertyInstance } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { clipboardPlugin } from '../plugins/builtin/clipboard'
import { timePropertiesPlugin } from '../plugins/builtin/properties/time'
import { constantMap, curveMap, reverseMap } from './time-remap'
import { audioPlan } from '../plugins/builtin/export-request'
import type { PropertyContribution } from './plugin-api'

const clip = (id: string, start: number, sourceIn = 5 * S, linkId?: string): Clip => ({ id, type: id.startsWith('a') ? 'sound' : 'picture', name: id, mediaId: 'm', start, duration: 4 * S, sourceIn, linkId, properties: [], data: {} })
async function editor() {
  const app = new CascadeApp('editor', null)
  app.registries.mediaTypes.register({ id: 'picture', name: 'Picture', icon: 'film', color: '#888', track: 'visual', timeBased: true, stage: { mount: () => ({ update() {}, dispose() {} }) } }, 'test', true)
  app.registries.mediaTypes.register({ id: 'sound', name: 'Sound', icon: 'volume-2', color: '#888', track: 'audio', timeBased: true, stage: { mount: () => ({ update() {}, dispose() {} }) } }, 'test', true)
  await new PluginHost(app).activate(timePropertiesPlugin, true)
  await new PluginHost(app).activate(clipboardPlugin, true)
  app.doc.transact('setup', (d) => {
    d.media.m = { id: 'm', name: 'media', type: 'picture', path: '/media', meta: { duration: 30 * S, hasAudio: true } }
    const tl = d.timelines[d.activeTimeline]
    tl.tracks[0].clips = [clip('v1', 0, 5 * S, 'L1'), clip('v2', 4 * S, 5 * S, 'L2'), clip('v3', 8 * S, 5 * S, 'L3')]
    tl.tracks[3].clips = [clip('a1', 0, 5 * S, 'L1'), clip('a2', 4 * S, 5 * S, 'L2'), clip('a3', 8 * S, 5 * S, 'L3')]
  })
  return app
}
const get = (app: CascadeApp, id: string) => findClip(app.timeline(), id)!.clip

describe('undoable linked tools', () => {
  it('rolls both tracks together and coalesces a whole drag as one undo', async () => {
    const app = await editor(), before = JSON.stringify(app.project())
    app.edit.rollEdit('v2', 'start', S, { gesture: 'start' })
    app.edit.rollEdit('v2', 'start', S, { gesture: 'update' })
    app.edit.rollEdit('v2', 'start', 0, { gesture: 'end' })
    expect([get(app, 'v1').duration, get(app, 'a1').duration]).toEqual([6 * S, 6 * S])
    expect([get(app, 'v2').start, get(app, 'a2').start]).toEqual([6 * S, 6 * S])
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('slips and slides linked clips, with handle limits shared across the pair', async () => {
    const app = await editor()
    app.edit.slipClip('v2', -20 * S)
    expect([get(app, 'v2').sourceIn, get(app, 'a2').sourceIn]).toEqual([0, 0])
    expect(get(app, 'v2').start).toBe(4 * S)
    app.edit.slideClip('v2', S)
    expect([get(app, 'v2').start, get(app, 'a2').start]).toEqual([5 * S, 5 * S])
    expect([get(app, 'v1').duration, get(app, 'a1').duration]).toEqual([5 * S, 5 * S])
    expect([get(app, 'v3').sourceIn, get(app, 'a3').sourceIn]).toEqual([6 * S, 6 * S])
    expect(clipEnd(get(app, 'v3'))).toBe(12 * S)
  })
  it('a locked linked member blocks roll, slip, slide, normal/ripple trim and delete', async () => {
    const app = await editor()
    app.edit.updateTrack(app.timeline().tracks[3].id, { locked: true })
    const before = JSON.stringify(app.project())
    app.edit.rollEdit('v2', 'start', S)
    app.edit.slipClip('v2', S)
    app.edit.slideClip('v2', S)
    app.edit.trimClip('v2', 'end', 10 * S)
    app.edit.rippleTrim('v2', 'end', 10 * S)
    app.edit.deleteClips(['v2'], true)
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('explicit ripple options drive ordinary trim and Delete; the clipboard plugin resolves the setting for cut', async () => {
    const app = await editor()
    await new PluginHost(app).activate(clipboardPlugin, true)
    app.settings.set('timeline.rippleMode', true)
    app.edit.trimClip('v1', 'end', 5 * S, { ripple: true })
    expect([get(app, 'v2').start, get(app, 'a2').start]).toEqual([5 * S, 5 * S])
    app.edit.deleteClips(['v1'], { ripple: true })
    expect([get(app, 'v2').start, get(app, 'a2').start]).toEqual([0, 0])
    app.selection.setClips(['v2'])
    await app.clipboard.cut()
    expect([get(app, 'v3').start, get(app, 'a3').start]).toEqual([0, 0])
  })
  it('skips roll/slide when an adjusted neighbour has a linked partner outside the edit', async () => {
    const app = await editor()
    app.doc.transact('mismatched neighbour', (d) => {
      d.timelines[d.activeTimeline].tracks[3].clips[0].linkId = undefined
    })
    app.edit.rollEdit('v2', 'start', S)
    // This is safe: the remaining left video is now an unpaired group.
    expect(get(app, 'v1').duration).toBe(5 * S)
    app.doc.undo()
    // Add a third linked member on another track, which must also be updated or block the edit.
    app.doc.transact('extra partner', (d) => {
      d.timelines[d.activeTimeline].tracks[1].clips.push(clip('extra', 0, 5 * S, 'L1'))
    })
    const extra = JSON.stringify(app.project())
    app.edit.slideClip('v2', S)
    expect(JSON.stringify(app.project())).toBe(extra)
  })
})

describe('property paste', () => {
  it('replaces non-stackable instances, appends stackable ones, respects applicability and undo', async () => {
    const app = await editor()
    for (const [id, stackable] of [['single', false], ['stack', true]] as const) app.registries.properties.register({ id, name: id, icon: '', description: '', category: '', params: [], stackable, appliesTo: ['picture'] } satisfies PropertyContribution, 'test', true)
    const p = (id: string, type: string): PropertyInstance => ({ id, type, enabled: true, params: { x: { value: 1, keyframes: [{ id: 'kf', t: S, value: 3, easing: { id: 'missing' } }] } } })
    app.edit.pasteProperties(['v1', 'a1'], [p('p1', 'single'), p('p2', 'stack')])
    const before = JSON.stringify(app.project())
    app.edit.pasteProperties(['v1', 'a1'], [p('p1', 'single'), p('p2', 'stack')], { includeKeyframes: false })
    const props = get(app, 'v1').properties
    expect(props.filter((p) => p.type === 'single')).toHaveLength(1)
    expect(props.filter((p) => p.type === 'stack')).toHaveLength(2)
    expect(props.find((p) => p.type === 'single')!.params.x.keyframes).toBeUndefined()
    expect(props[0].params.x.keyframes![0].id).not.toBe('kf')
    expect(get(app, 'a1').properties).toEqual([])
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('keeps opaque properties whose plugin is unavailable, unless the destination declares incompatibility', async () => {
    const app = await editor()
    app.registries.properties.register({ id: 'declined', name: 'Declined', icon: '', description: '', category: '', params: [], appliesTo: ['sound'] } satisfies PropertyContribution, 'test', true)
    const opaque: PropertyInstance = { id: 'o', type: 'gone.plugin', enabled: true, params: { mystery: { value: { a: [1] }, keyframes: [{ id: 'kf', t: S, value: 3, easing: { id: 'x' } }] } } }
    app.edit.pasteProperties(['v1'], [opaque, { id: 'd', type: 'declined', enabled: true, params: {} }])
    const props = get(app, 'v1').properties
    expect(props.map(p => p.type)).toEqual(['gone.plugin'])
    expect(props[0].id).not.toBe('o')
    expect(props[0].params.mystery.value).toEqual({ a: [1] })
    expect(props[0].params.mystery.keyframes![0].id).not.toBe('kf')
  })
  it('copies a single property through the clipboard and skips locked paste targets', async () => {
    const app = await editor()
    const prop = app.edit.addProperty('v1', 'speed')!
    app.edit.setParam('v1', prop, 'speed', 2)
    app.edit.addKeyframe('v1', prop, 'speed', S, 3, { id: 'linear' })
    await app.clipboard.copyProperty('v1', prop)
    const payload = await app.clipboard.read()
    expect(payload?.format).toBe('property')
    const before = JSON.stringify(app.project())
    await app.clipboard.pasteProperty(['v2'])
    const pasted = get(app, 'v2').properties[0]
    expect(pasted.type).toBe('speed')
    expect(pasted.id).not.toBe(prop)
    expect(pasted.params.speed.keyframes![0].id).not.toBe(get(app, 'v1').properties[0].params.speed.keyframes![0].id)
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
    app.edit.updateTrack(app.timeline().tracks[0].id, { locked: true })
    const locked = JSON.stringify(app.project())
    await app.clipboard.pasteProperty(['v2'])
    expect(JSON.stringify(app.project())).toBe(locked)
  })

})

describe('freeze and zero-speed maps', () => {
  it('holds a source frame at the playhead, splits/ripples partners with a silent audio interval, and undoes once', async () => {
    const app = await editor(), before = JSON.stringify(app.project())
    const id = app.edit.freezeFrame('v1', S, 2 * S)!
    const hold = get(app, id)
    expect(hold).toMatchObject({ start: S, duration: 2 * S, sourceIn: 6 * S, linkId: undefined })
    expect(app.edit.timeMap(hold).constant).toBe(0)
    expect(app.edit.timeMap(hold).offset(2 * S)).toBe(0)
    const audio = app.timeline().tracks[3].clips
    expect(audio.map((c) => [c.start, c.duration])).toEqual([[0, S], [3 * S, 3 * S], [6 * S, 4 * S], [10 * S, 4 * S]])
    const visualRight = app.timeline().tracks[0].clips.find((c) => c.start === 3 * S)!
    expect(visualRight.linkId).toBe(audio[1].linkId)
    expect(visualRight.sourceIn).toBe(6 * S)
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('samples the integral of reversed/keyframed speed and freezes other property animation', async () => {
    const app = await editor()
    app.edit.updateClip('v1', { speed: 2 })
    const speed = get(app, 'v1').properties[0]
    app.edit.setParam('v1', speed.id, 'reverse', true)
    const hold = app.edit.freezeFrame('v1', S, S)!
    expect(get(app, hold).sourceIn).toBe(3 * S)
    expect(app.edit.timeMap(hold).offset(S)).toBe(-0)
    app.doc.undo()
    app.edit.setParam('v1', speed.id, 'reverse', false)
    app.edit.addKeyframe('v1', speed.id, 'speed', 0, 1, { id: 'linear' })
    app.edit.addKeyframe('v1', speed.id, 'speed', 2 * S, 3, { id: 'linear' })
    const id = app.edit.freezeFrame('v1', S, S)!
    expect(get(app, id).sourceIn).toBe(6.5 * S)
    expect(app.edit.timeMap(id).constant).toBe(0)
  })
  it('refuses locked partners, invalid durations, missing selection and timeline-end holds', async () => {
    const app = await editor()
    expect(app.edit.freezeFrame('missing', 0)).toBeNull()
    expect(app.edit.freezeFrame('v1', 4 * S)).toBeNull()
    expect(app.edit.freezeFrame('v1', S, -S)).toBeNull()
    app.edit.updateTrack(app.timeline().tracks[3].id, { locked: true })
    const before = JSON.stringify(app.project())
    expect(app.edit.freezeFrame('v1', S)).toBeNull()
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('rebases ramp integrals after a linked head trim, including reverse and a subsequent frame hold', async () => {
    const app = await editor()
    app.edit.updateClip('v1', { speed: 1 })
    const prop = get(app, 'v1').properties[0]
    app.edit.addKeyframe('v1', prop.id, 'speed', 0, 1, { id: 'linear' })
    app.edit.addKeyframe('v1', prop.id, 'speed', 2 * S, 3, { id: 'linear' })
    app.edit.trimClip('v1', 'start', S)
    for (const id of ['v1', 'a1']) {
      expect(get(app, id).sourceIn).toBe(6.5 * S)
      expect(app.edit.timeMap(id).offset(0)).toBe(0)
      expect(app.edit.timeMap(id).offset(S)).toBe(2.5 * S)
    }
    const hold = app.edit.freezeFrame('v1', 2 * S, S)!
    expect(get(app, hold).sourceIn).toBe(9 * S)
    app.doc.undo()
    app.edit.setParam('v1', prop.id, 'reverse', true)
    expect(app.edit.timeMap('v1').offset(0)).toBe(-0)
    expect(app.edit.timeMap('v1').offset(S)).toBe(-2.5 * S)
  })
  it('freezes through a plugin-defined remap property already on the clip', async () => {
    const app = await editor()
    app.registries.properties.register({ id: 'custom-clock', name: 'Clock', icon: '', category: '', description: '', params: [{ id: 'rate', label: 'Rate', type: 'number', default: 1 }], timeRemap: 'rate', appliesTo: ['picture'] }, 'third-party', false)
    const p = app.edit.addProperty('v1', 'custom-clock')!
    app.edit.setParam('v1', p, 'rate', 2)
    const hold = app.edit.freezeFrame('v1', S, S)!
    expect(get(app, hold).sourceIn).toBe(7 * S)
    expect(get(app, hold).properties.find((p) => p.type === 'custom-clock')!.params.rate.value).toBe(0)
    expect(app.edit.timeMap(hold).constant).toBe(0)
  })
  it('zero-speed maps integrate without NaNs, trim with no source consumption, and export audio as silence', async () => {
    const app = await editor(), m = constantMap(0)
    expect(m.localAt(0)).toBe(0)
    expect(m.localAt(S)).toBe(Infinity)
    expect(m.localAt(-S)).toBe(-Infinity)
    expect(reverseMap(m).offset(S)).toBe(-0)
    app.edit.updateClip('v1', { speed: 0 })
    expect(app.edit.timeMap('a1').constant).toBe(0)
    expect(audioPlan(app, { start: 0, end: 4 * S }).a1).toBeUndefined()
    app.edit.rippleTrim('v1', 'end', 8 * S)
    expect(get(app, 'v1').duration).toBe(8 * S)
    expect(get(app, 'v1').sourceIn).toBe(5 * S)
    const map = curveMap(1, [{ id: 'a', t: 0, value: 0, easing: { id: 'linear' } }, { id: 'b', t: S, value: 0, easing: { id: 'linear' } }, { id: 'c', t: 2 * S, value: 2, easing: { id: 'linear' } }], app.registries)
    expect(map.offset(S)).toBe(0)
    expect(map.offset(2 * S)).toBe(S)
    expect(map.localAt(0)).toBe(0)
    expect(map.localAt(S / 4)).toBeCloseTo(1.5 * S, -1)
  })
})

it('exports a zero-containing audio ramp as stretched moving intervals and skips a wholly silent plateau range', async () => {
  const app = await editor()
  app.edit.updateClip('v1', { speed: 0 })
  const prop = get(app, 'v1').properties[0]
  app.edit.addKeyframe('v1', prop.id, 'speed', 0, 0, { id: 'hold' })
  app.edit.addKeyframe('v1', prop.id, 'speed', S, 0, { id: 'linear' })
  app.edit.addKeyframe('v1', prop.id, 'speed', 2 * S, 2, { id: 'linear' })
  expect(audioPlan(app, { start: 0, end: S }).a1).toBeUndefined()
  const plan = audioPlan(app, { start: 0, end: 4 * S }).a1
  expect(plan.mode).toBe('stretch')
  expect(plan.segments).toHaveLength(1)
  expect(plan.segments![0].localStart).toBeCloseTo(1, 2)
  expect(plan.segments![0].localEnd).toBeCloseTo(4, 2)
})
