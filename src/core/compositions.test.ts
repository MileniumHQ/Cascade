import { expect, test } from 'vitest'
import { createProject, createTimeline, type Clip } from '@shared/project'
import { canReferenceTimeline, timelineDependencies } from './compositions'
import { DocumentStore } from './document'

const clip = (id: string, mediaId: string): Clip => ({ id, mediaId, type: 'missing-plugin', name: id, start: 0, duration: 1, sourceIn: 0, properties: [], data: {} })
function fixture() {
  const p = createProject('Graph')
  for (const id of ['a', 'b', 'c']) { p.timelines[id] = { ...createTimeline(id), id }; p.timelineOrder.push(id); p.media[id] = { id, name: id, type: 'missing-plugin', meta: {}, timelineId: id } }
  p.timelines.a.tracks[0].clips = [clip('ab', 'b')]
  p.timelines.b.tracks[0].clips = [clip('bc', 'c')]
  return p
}

test('generic references reject direct/indirect cycles and missing sources, permit shared descendants', () => {
  const p = fixture()
  expect([...timelineDependencies(p, 'a')]).toEqual(['b'])
  expect(canReferenceTimeline(p, 'a', 'a')).toBe(false)
  expect(canReferenceTimeline(p, 'c', 'a')).toBe(false)
  expect(canReferenceTimeline(p, 'c', 'b')).toBe(false)
  expect(canReferenceTimeline(p, 'a', 'c')).toBe(true)
  expect(canReferenceTimeline(p, 'a', 'missing')).toBe(false)
})

test('all transactions including plugin/paste inserts validate edges atomically, without a registered plugin', () => {
  const store = new DocumentStore(fixture()), before = store.state
  expect(() => store.transact('cycle', d => { d.timelines.c.tracks[0].clips.push(clip('ca', 'a')) })).toThrow(/cannot contain itself/)
  expect(store.state).toBe(before)
  expect(store.canUndo).toBe(false)
  expect(() => store.transact('delete referenced', d => { delete d.timelines.c })).toThrow(/used/)
  expect(store.state).toBe(before)
  store.transact('unknown data', d => { d.media.a.data = { unknown: 'preserved' } })
  expect(store.state.media.a.timelineId).toBe('a')
})

test('malformed old cycles can be opened, renamed and repaired without losing data', () => {
  const p = fixture()
  p.timelines.c.tracks[0].clips = [clip('ca', 'a')]
  const store = new DocumentStore(p)
  store.transact('rename', d => { d.timelines.a.name = 'Renamed' })
  expect(store.state.timelines.c.tracks[0].clips[0].type).toBe('missing-plugin')
  store.transact('repair', d => { d.timelines.c.tracks[0].clips = [] })
  expect(canReferenceTimeline(store.state, 'a', 'c')).toBe(true)
})
