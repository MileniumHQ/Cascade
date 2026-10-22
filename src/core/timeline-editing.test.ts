import { expect, test } from 'vitest'
import { CascadeApp } from './app'
import { PluginHost } from './plugin-host'
import { findClip, type Clip } from '@shared/project'
import { FLICKS } from '@shared/time'
import { sequencePlugin } from '../plugins/builtin/sequence'
import { timePropertiesPlugin } from '../plugins/builtin/properties/time'

const S = (n: number) => Math.round(n * FLICKS)
const clip = (id: string, start = 0): Clip => ({ id, name: id, type: 'unknown-plugin', start: S(start), duration: S(4), sourceIn: 0, properties: [], data: {} })
async function app() {
  const a = new CascadeApp('render', null), host = new PluginHost(a)
  await host.activate(sequencePlugin, true)
  await host.activate(timePropertiesPlugin, true)
  return a
}

test('create, rename, reorder, duplicate and delete are undoable; navigation restores playheads outside undo', async () => {
  const a = await app(), main = a.project().activeTimeline
  a.playback.seek(S(3))
  const second = a.edit.createTimeline({ name: 'Second' })
  a.edit.setActiveTimeline(second)
  expect(a.playback.time.get()).toBe(0)
  a.playback.seek(S(8))
  a.selection.setClips(['stale'])
  a.selection.keyframes.set([{ clipId: 'stale', propertyId: 'p', paramId: 'x', keyframeId: 'k' }])
  a.selection.targets.set({ visual: 'stale' })
  a.edit.setActiveTimeline(main, true)
  expect(a.playback.time.get()).toBe(S(3))
  expect(a.selection.clips.get()).toEqual([])
  expect(a.selection.keyframes.get()).toEqual([])
  expect(a.selection.targets.get()).toEqual({})
  a.edit.previousTimeline()
  expect(a.project().activeTimeline).toBe(second)
  expect(a.playback.time.get()).toBe(S(8))
  expect(a.doc.undoLabel).toBe('Create timeline')
  a.edit.renameTimeline(second, 'Renamed')
  expect(a.project().timelines[second].name).toBe('Renamed')
  a.doc.undo()
  expect(a.project().timelines[second].name).toBe('Second')
  const third = a.edit.duplicateTimeline(second)!
  a.edit.reorderTimeline(third, 0)
  expect(a.project().timelineOrder[0]).toBe(third)
  a.doc.undo()
  expect(a.project().timelineOrder).toEqual([main, second, third])
  a.edit.setActiveTimeline(third)
  expect(a.edit.deleteTimeline(third)).toBe(true)
  expect(a.project().activeTimeline).toBe(main)
  a.doc.undo()
  expect(a.project().activeTimeline).toBe(third)
})

test('undoing creation while viewing that timeline chooses a valid timeline; redo is safe', async () => {
  const a = await app(), main = a.project().activeTimeline, second = a.edit.createTimeline()
  a.edit.setActiveTimeline(second)
  a.doc.undo()
  expect(a.project().activeTimeline).toBe(main)
  expect(a.project().timelines[second]).toBeUndefined()
  a.doc.redo()
  expect(a.project().timelines[second]).toBeDefined()
  expect(a.edit.deleteTimeline(main)).toBe(true)
  expect(a.edit.deleteTimeline(second)).toBe(false)
})

test('nest and break apart each use one undo step, with linked audio and source data restored', async () => {
  const a = await app()
  a.doc.transact('fixture', d => {
    const tl = d.timelines[d.activeTimeline]
    tl.tracks[0].clips = [{ ...clip('picture', 2), linkId: 'L' }]
    tl.tracks[3].clips = [{ ...clip('sound', 2), linkId: 'L' }]
  })
  const before = a.project(), id = a.edit.nestClips(['picture'], { mediaType: 'sequence' })!
  const nested = a.project().media[findClip(a.timeline(), id)!.clip.mediaId!].timelineId!
  expect(a.doc.undoLabel).toBe('Nest clips')
  expect(a.timeline().tracks[3].clips).toEqual([])
  expect(a.edit.deleteTimeline(nested)).toBe(false)
  expect(a.edit.breakApartClipReason(id)).toBeNull()
  const expanded = a.edit.breakApartClip(id)!
  expect(expanded).toHaveLength(2)
  expect(a.doc.undoLabel).toBe('Break apart')
  a.doc.undo()
  expect(findClip(a.timeline(), id)).not.toBeNull()
  a.doc.undo()
  expect(a.project()).toEqual(before)
  a.doc.redo()
  expect(findClip(a.timeline(), id)).not.toBeNull()
})

test('live composition lengths drive build, trim and slip; edits cannot introduce recursion', async () => {
  const a = await app(), main = a.project().activeTimeline, child = a.edit.createTimeline()
  a.edit.setActiveTimeline(child)
  a.doc.transact('child', d => { d.timelines[child].tracks[0].clips = [clip('content')] })
  a.edit.setActiveTimeline(main)
  const id = a.edit.addComposition(child, 'sequence')!
  expect(findClip(a.timeline(), id)!.clip.duration).toBe(S(4))
  const media = a.project().media[findClip(a.timeline(), id)!.clip.mediaId!]
  a.doc.transact('extend child', d => { d.timelines[child].tracks[0].clips[0].duration = S(8) })
  expect(a.edit.buildClip(media, 0)!.duration).toBe(S(8))
  a.edit.trimClip(id, 'end', S(30))
  expect(findClip(a.timeline(), id)!.clip.duration).toBe(S(8))
  a.edit.setActiveTimeline(child)
  const before = a.project()
  expect(a.edit.addComposition(main, 'sequence')).toBeNull()
  expect(a.project()).toBe(before)
  expect(a.edit.addMediaToTimeline(media.id)).toEqual([])
  expect(a.edit.placeSource('overwrite', media.id)).toBeNull()
  expect(a.project()).toBe(before)
})

test('break apart provides explicit reasons for reverse, ramps, wrapper effects and transition boundaries', async () => {
  const a = await app()
  a.doc.transact('fixture', d => { d.timelines[d.activeTimeline].tracks[0].clips = [clip('picture')] })
  const id = a.edit.nestClips(['picture'], { mediaType: 'sequence' })!
  a.edit.addProperty(id, 'speed')
  const speed = findClip(a.timeline(), id)!.clip.properties[0].id
  a.edit.setParam(id, speed, 'speed', 2)
  expect(a.edit.breakApartClipReason(id)).toMatch(/1×/)
  a.edit.setParam(id, speed, 'speed', 1)
  a.edit.setParam(id, speed, 'reverse', true)
  expect(a.edit.breakApartClipReason(id)).toMatch(/1×/)
  a.edit.setParam(id, speed, 'reverse', false)
  expect(a.edit.breakApartClipReason(id)).toBeNull()
  a.doc.transact('unknown effect', d => { findClip(d.timelines[d.activeTimeline], id)!.clip.properties.push({ id: 'effect', type: 'missing', enabled: true, params: {} }) })
  expect(a.edit.breakApartClipReason(id)).toMatch(/effects/)
})
