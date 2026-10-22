import { describe, expect, it } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import { findClip } from '@shared/project'
import { FLICKS } from '@shared/time'
import { ellipsePath, interpolatePath, rectanglePath, type PathValue } from '@shared/path'
import { defaultCurves, interpolateCurves } from '@shared/curve'
import { maskProperty, masksPlugin } from './index'
import { curvesProperty } from '../color/curves'
import { selectedPath } from '../params/path-target'

async function editor() {
  const app = new CascadeApp('editor', null), host = new PluginHost(app)
  await host.activateAll([{ def: masksPlugin, builtin: true }])
  app.registries.paramTypes.register({ id: 'path', interpolate: interpolatePath, directEdit: 'path-editor', editor() {} }, 'test', true)
  app.registries.paramTypes.register({ id: 'curve', interpolate: interpolateCurves, editor() {} }, 'test', true)
  app.registries.properties.register(curvesProperty, 'test', true)
  app.registries.mediaTypes.register({ id: 'third-party-visual', name: 'Visual', icon: 'film', color: '#fff', track: 'visual', pixels: true, stage: { mount() { return { update() {}, dispose() {} } } } }, 'test', true)
  app.doc.transact('fixture', d => {
    d.timelines[d.activeTimeline].tracks[0].clips.push({ id: 'clip', type: 'third-party-visual', name: 'Clip', start: FLICKS, duration: 5 * FLICKS, sourceIn: 0, properties: [], data: {} })
  })
  const id = app.edit.addProperty('clip', 'mask')!
  app.selection.setClips(['clip']); app.selection.property.set(id); app.playback.time.set(FLICKS)
  return { app, id, property: () => findClip(app.timeline(), 'clip')!.clip.properties.find(p => p.id === id)! }
}

describe('path/curve integration with editing', () => {
  it('creates a shape key at the gesture start time and undoes the entire gesture', async () => {
    const { app, id, property } = await editor()
    app.edit.toggleKeyframe('clip', id, 'shape')
    const before = structuredClone(property())
    app.playback.time.set(2 * FLICKS)
    const at = app.edit.localTime('clip')
    app.edit.setParam('clip', id, 'shape', rectanglePath(), { gesture: 'start', at })
    // A playhead change during a drag must not scatter new keys.
    app.playback.time.set(3 * FLICKS)
    app.edit.setParam('clip', id, 'shape', rectanglePath(0.1), { gesture: 'update', at })
    app.edit.setParam('clip', id, 'shape', rectanglePath(0.15), { gesture: 'end', at })
    expect(property().params.shape.keyframes!.map(k => k.t)).toEqual([0, FLICKS])
    expect(property().params.shape.keyframes![1].value).toEqual(rectanglePath(0.15))
    app.doc.undo(); expect(property()).toEqual(before)
    app.doc.redo(); expect(property().params.shape.keyframes![1].value).toEqual(rectanglePath(0.15))
  })
  it('keeps adjacent drags separate and preserves unknown plugin data', async () => {
    const { app, id, property } = await editor()
    app.edit.setParam('clip', id, 'shape', rectanglePath(), { gesture: 'start' })
    app.edit.setParam('clip', id, 'shape', rectanglePath(0.1), { gesture: 'end' })
    app.edit.setParam('clip', id, 'shape', rectanglePath(0.3), { gesture: 'start' })
    app.edit.setParam('clip', id, 'shape', rectanglePath(0.4), { gesture: 'end' })
    app.doc.undo(); expect(property().params.shape.value).toEqual(rectanglePath(0.1))
    const data = JSON.stringify(app.project()); const registration = app.registries.properties.get('mask')
    expect(registration).toBeTruthy()
    // Opening the JSON without its plugin retains every parameter and path point.
    const fresh = new CascadeApp('editor', null); fresh.doc.load(JSON.parse(data))
    expect(JSON.stringify(fresh.project())).toBe(data)
  })
  it('finds paths on arbitrary properties and respects selected param and track locking', async () => {
    const { app } = await editor()
    app.registries.properties.register({ ...maskProperty, id: 'example.path', params: [{ id: 'first', label: 'First', type: 'path', default: ellipsePath() }, { id: 'second', label: 'Second', type: 'path', default: rectanglePath() }] }, 'test', true)
    const id = app.edit.addProperty('clip', 'example.path')!; app.selection.property.set(id)
    expect(selectedPath(app)?.paramId).toBe('first')
    app.selection.param.set('second')
    expect(selectedPath(app)?.value).toEqual(rectanglePath())
    app.edit.updateTrack(app.timeline().tracks[0].id, { locked: true })
    expect(selectedPath(app)).toBeNull()
  })
  it('animates curve values through the same API and interpolates path tangents', async () => {
    const { app, id } = await editor()
    app.edit.addKeyframe('clip', id, 'shape', 0, rectanglePath(), { id: 'linear' })
    app.edit.addKeyframe('clip', id, 'shape', 2 * FLICKS, ellipsePath(), { id: 'linear' })
    app.playback.time.set(2 * FLICKS)
    expect((app.edit.paramValue('clip', id, 'shape') as PathValue).points[0].x).toBeCloseTo(0.35)
    const curveId = app.edit.addProperty('clip', 'curves')!
    app.edit.toggleKeyframe('clip', curveId, 'curve')
    app.playback.time.set(3 * FLICKS)
    const v = defaultCurves(); v.master[0][1] = 0.3
    app.edit.setParam('clip', curveId, 'curve', v, { gesture: 'start' })
    app.edit.setParam('clip', curveId, 'curve', v, { gesture: 'end' })
    expect(app.edit.paramValue('clip', curveId, 'curve')).toEqual(v)
    app.doc.undo(); expect(app.edit.paramValue('clip', curveId, 'curve')).toEqual(defaultCurves())
  })
})
