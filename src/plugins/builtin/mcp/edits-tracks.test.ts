import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import { easingsPlugin } from '../easings'
import { elementPlugin } from '../media/element'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { applyEdits, Ids, parseTimeText } from './edits'
import { FLICKS, frameToFlicks } from '@shared/time'

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([easingsPlugin, elementPlugin, visualPropertiesPlugin, textPropertiesPlugin].map(def => ({ def, builtin: true })))
  return app
}
const param = (app: CascadeApp, clipIndex: number, type: string, id: string, track = 0) =>
  app.timeline().tracks[track].clips[clipIndex].properties.find(p => p.type === type)!.params[id]

test('time text: clock times as printed (decimal seconds) and unit amounts', () => {
  const fps = { num: 30, den: 1 }
  expect(parseTimeText('00:01:23.500', fps)).toBe(83.5 * FLICKS)
  expect(parseTimeText('00:01:23.5', fps)).toBe(83.5 * FLICKS)
  expect(parseTimeText('1:23', fps)).toBe(83 * FLICKS)
  expect(parseTimeText('83.5s', fps)).toBe(83.5 * FLICKS)
  expect(parseTimeText('500ms', fps)).toBe(FLICKS / 2)
  expect(parseTimeText('12f', fps)).toBe(frameToFlicks(12, fps))
  expect(() => parseTimeText('00:01:75.000', fps)).toThrow(/Invalid time/)
})

test('timecode strings work in batch times', async () => {
  const app = await editor()
  applyEdits(app, { ops: [{ op: 'add_text', text: 'A', start: '00:00:02.00', duration: 2 * FLICKS }, { op: 'add_marker', time: '3.5s', name: 'm' }] }, new Ids())
  expect(app.timeline().tracks[0].clips[0].start).toBe(2 * FLICKS)
  expect(app.timeline().markers[0].t).toBe(3.5 * FLICKS)
})

test('copy_properties applies a look but keeps each caption\'s text; clear_keyframes leaves a static value', async () => {
  const app = await editor(), ids = new Ids()
  applyEdits(app, { ops: [
    { op: 'add_text', text: 'one', start: 0, duration: FLICKS, ref: 'a' },
    { op: 'add_text', text: 'two', start: FLICKS, duration: FLICKS, ref: 'b' },
    { op: 'add_text', text: 'three', start: 2 * FLICKS, duration: FLICKS, ref: 'c' },
    { op: 'set_param', clipId: 'a', propertyId: 'text', paramId: 'color', value: '#ffee00' },
    { op: 'add_keyframes', clipId: 'a', propertyId: 'transform', paramId: 'position', keys: [{ time: 0, value: [0, 0.3] }, { time: FLICKS / 2, value: [0, 0.4] }] },
    { op: 'copy_properties', fromClipId: 'a', toClipIds: ['b', 'c'] },
    { op: 'clear_keyframes', clipId: 'c', propertyId: 'transform', paramId: 'position' }
  ] }, ids)
  expect(param(app, 1, 'text', 'color').value).toBe('#ffee00')
  expect(param(app, 1, 'text', 'text').value).toBe('two')
  expect(param(app, 1, 'transform', 'position').keyframes).toHaveLength(2)
  expect(param(app, 2, 'transform', 'position').keyframes).toBeUndefined()
  expect(param(app, 2, 'transform', 'position').value).toEqual([0, 0.3])
})

test('track ops: add with ref, rename, reorder and remove with its clips', async () => {
  const app = await editor(), ids = new Ids()
  const first = app.timeline().tracks.find(t => t.kind === 'visual')!.id
  applyEdits(app, { ops: [
    { op: 'add_track', kind: 'visual', name: 'Titles', ref: 'titles' },
    { op: 'add_text', text: 'x', start: 0, duration: FLICKS, trackId: 'titles' },
    { op: 'move_track', trackId: 'titles', index: 0 },
    { op: 'update_track', trackId: first, name: 'Picture', hidden: true }
  ] }, ids)
  const visual = app.timeline().tracks.filter(t => t.kind === 'visual')
  expect(visual.map(t => t.name).slice(0, 2)).toEqual(['Titles', 'Picture'])
  expect(visual[1].hidden).toBe(true)
  applyEdits(app, { ops: [{ op: 'remove_track', trackId: visual[0].id }] }, ids)
  expect(app.timeline().tracks.some(t => t.name === 'Titles')).toBe(false)
})

test('dry run validates without committing; a clip removed earlier in the batch is named', async () => {
  const app = await editor(), ids = new Ids(), before = app.project()
  expect(applyEdits(app, { ops: [{ op: 'add_text', text: 'x', start: 0, duration: FLICKS }] }, ids, undefined, { dryRun: true })).toMatch(/Nothing was committed/)
  expect(app.project()).toBe(before)
  applyEdits(app, { ops: [{ op: 'add_text', text: 'x', start: 0, duration: FLICKS }] }, ids)
  const id = app.timeline().tracks[0].clips[0].id
  expect(() => applyEdits(app, { ops: [{ op: 'delete', clipId: id }, { op: 'delete', clipId: id }] }, ids)).toThrow(/already removed by operation 1 \(delete/)
})
