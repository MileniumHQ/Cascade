import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import { elementPlugin } from '../media/element'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { applyEdits, Ids } from './edits'
import { FLICKS } from '@shared/time'

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([elementPlugin, visualPropertiesPlugin, textPropertiesPlugin].map(def => ({ def, builtin: true })))
  return app
}
test('dependent edits, animation, split and ripple range commit as one labeled undo step', async () => {
  const app = await editor(), ids = new Ids(), before = app.project()
  applyEdits(app, { ops: [
    { op: 'add_text', text: 'Hello', start: 0, duration: 10 * FLICKS, ref: 'title' },
    { op: 'add_keyframe', clipId: 'title', propertyId: 'transform', paramId: 'position', time: 0, value: [-0.3, 0] },
    { op: 'add_keyframe', clipId: 'title', propertyId: 'transform', paramId: 'position', time: 2 * FLICKS, value: [0, 0] },
    { op: 'split', clipId: 'title', time: 5 * FLICKS, ref: 'right' },
    { op: 'ripple_delete', start: 6 * FLICKS, end: 8 * FLICKS }
  ] }, ids)
  expect(app.duration()).toBe(8 * FLICKS)
  expect(app.timeline().tracks[0].clips[0].properties.find(p => p.type === 'transform')!.params.position.keyframes).toHaveLength(2)
  expect(app.doc.undoLabel).toBe('Agent: apply 5 edits')
  app.doc.undo()
  expect(app.project()).toEqual(before)
  expect(app.doc.canUndo).toBe(false)
  app.doc.redo()
  expect(app.duration()).toBe(8 * FLICKS)
})
test('invalid later operation rolls back entire batch and preserves undo history', async () => {
  const app = await editor(), ids = new Ids(), before = app.project()
  expect(() => applyEdits(app, { ops: [
    { op: 'add_text', text: 'Temporary', start: 0, duration: FLICKS, ref: 'new' },
    { op: 'set_param', clipId: 'new', propertyId: 'transform', paramId: 'position', value: [10, 'bad'] }
  ] }, ids)).toThrow(/No edits applied/)
  expect(app.project()).toBe(before)
  expect(app.doc.canUndo).toBe(false)
})
test('locked target and incompatible properties reject without changes', async () => {
  const app = await editor(), ids = new Ids()
  applyEdits(app, { ops: [{ op: 'add_text', text: 'Locked', start: 0, duration: FLICKS }] }, ids)
  const id = app.timeline().tracks[0].clips[0].id
  app.doc.transact('Lock', d => { d.timelines[d.activeTimeline].tracks[0].locked = true })
  const before = app.project()
  expect(() => applyEdits(app, { ops: [{ op: 'delete', clipId: id }] }, ids)).toThrow(/locked/)
  expect(app.project()).toBe(before)
})
test('source clips keep linked audio across split and move; locked counterpart blocks ripple shifts', async () => {
  const app = await editor(), ids = new Ids()
  app.registries.mediaTypes.register({ id: 'video', name: 'Video', icon: 'film', color: '#eee', track: 'visual', timeBased: true, linkedAudioType: 'audio', stage: { mount: () => ({ update() {}, dispose() {} }) } }, 'test', true)
  app.registries.mediaTypes.register({ id: 'audio', name: 'Audio', icon: 'music', color: '#eee', track: 'audio', timeBased: true, stage: { mount: () => ({ update() {}, dispose() {} }) } }, 'test', true)
  app.doc.transact('Fixture', d => { d.media.source = { id: 'source', name: 'Source', type: 'video', meta: { hasAudio: true, duration: 30 * FLICKS } }; d.mediaOrder.push('source') })
  applyEdits(app, { ops: [
    { op: 'add_clip', mediaId: 'source', start: 0, duration: 10 * FLICKS, ref: 'v' },
    { op: 'split', clipId: 'v', time: 5 * FLICKS, ref: 'r' },
    { op: 'move', clipId: 'r', start: 10 * FLICKS }
  ] }, ids)
  const visual = app.timeline().tracks.find(t => t.kind === 'visual')!
  const audio = app.timeline().tracks.find(t => t.kind === 'audio')!
  expect(visual.clips.map(c => c.start)).toEqual([0, 10 * FLICKS])
  expect(audio.clips.map(c => c.start)).toEqual([0, 10 * FLICKS])
  expect(visual.clips[1].linkId).toBe(audio.clips[1].linkId)
  app.doc.transact('Lock audio', d => { d.timelines[d.activeTimeline].tracks.find(t => t.id === audio.id)!.locked = true })
  const before = app.project()
  expect(() => applyEdits(app, { ops: [{ op: 'ripple_delete', start: 6 * FLICKS, end: 8 * FLICKS }] }, ids)).toThrow(/locked/)
  expect(app.project()).toBe(before)
})
test('ripple_delete removes the range exactly once even with the UI ripple mode on, and shifts later markers once', async () => {
  const app = await editor(), ids = new Ids()
  app.settings.set('timeline.rippleMode', true)
  applyEdits(app, { ops: [{ op: 'add_text', text: 'Long', start: 0, duration: 12 * FLICKS }, { op: 'add_marker', time: 12 * FLICKS, name: 'End' }] }, ids)
  applyEdits(app, { ops: [{ op: 'ripple_delete', start: 2 * FLICKS, end: 4 * FLICKS }] }, ids)
  expect(app.duration()).toBe(10 * FLICKS)
  expect(app.timeline().markers.map(m => m.t)).toEqual([10 * FLICKS])
})
