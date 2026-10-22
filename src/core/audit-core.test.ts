import { expect, test } from 'vitest'
import { DocumentStore } from './document'
import { createProject, createTimeline, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { insertClips } from './three-point'
import { clearRange, splitClip, withTimeMaps } from './timeline-ops'
import { constantMap, reverseMap } from './time-remap'
import { nestReason, nestClips } from './nesting'

const clip = (id: string, start = 0, duration = 2 * S, linkId?: string): Clip => ({ id, type: 'external', name: id, start, duration, sourceIn: 5 * S, linkId, properties: [], data: {} })

test('three-point insert rejects locked linked partners without any mutation', () => {
  const tl = createTimeline()
  tl.tracks[0].clips = [clip('v', 2 * S, 2 * S, 'L')]
  tl.tracks[3].clips = [clip('a', 2 * S, 2 * S, 'L')]
  tl.tracks[3].locked = true
  tl.markers = [{ id: 'm', t: 6 * S, name: '' }]
  const before = structuredClone(tl)
  const result = insertClips(tl, [{ trackId: tl.tracks[0].id, clip: clip('new', S, S) }], S, S)
  expect(result.placed).toEqual([])
  expect(result.blocked).toContain('new')
  expect(tl).toEqual(before)
})

test('three-point insert shifts unrelated downstream content on linked tracks', () => {
  const tl = createTimeline()
  tl.tracks[0].clips = [clip('v', 2 * S, 2 * S, 'L')]
  tl.tracks[3].clips = [clip('a', 2 * S, 2 * S, 'L'), clip('tail', 4 * S)]
  insertClips(tl, [{ trackId: tl.tracks[0].id, clip: clip('new', S, S) }], S, S)
  expect(tl.tracks[3].clips.map(c => c.start)).toEqual([3 * S, 5 * S])
})

for (const reversed of [false, true]) for (const overwrite of [false, true]) test(`split preserves hidden source annotations (reverse=${reversed}, overwrite=${overwrite})`, () => {
  const tl = createTimeline(), tr = tl.tracks[0], c = clip('c', 0, 4 * S)
  c.sourceIn = reversed ? 9 * S : 5 * S
  c.markers = [3, 6, 8, 11].map(n => ({ id: `m${n}`, t: n * S, name: `${n}`, kind: 'missing-plugin', data: { retained: n } }))
  tr.clips = [c]
  withTimeMaps(() => (reversed ? reverseMap(constantMap(1)) : constantMap(1)), () => overwrite ? clearRange(tr, S, 3 * S) : splitClip(tr, 'c', 2 * S))
  const [left, right] = tr.clips
  expect(left.markers?.map(m => m.t)).toEqual((reversed ? [8, 11] : [3, 6]).map(n => n * S))
  expect(right.markers?.map(m => m.t)).toEqual((reversed ? [3, 6] : [8, 11]).map(n => n * S))
  expect(tr.clips.flatMap(c => c.markers ?? []).every(m => m.kind === 'missing-plugin' && !!m.data)).toBe(true)
})

test('nest rejects interleaved overlapping unselected visual layers atomically', () => {
  const tl = createTimeline()
  for (let i = 0; i < 3; i++) tl.tracks[i].clips = [clip(`v${i}`)]
  const before = structuredClone(tl)
  expect(nestReason(tl, ['v0', 'v2'])).toMatch(/visual|layer/i)
  expect(nestClips(tl, ['v0', 'v2'], clip('wrapper'), 'nested', 'Nested')).toBeNull()
  expect(tl).toEqual(before)
  tl.tracks[1].clips[0].start = 3 * S
  expect(nestReason(tl, ['v0', 'v2'])).toBeNull()
})

for (const load of [false, true]) test(`owned normalized snapshots are deeply frozen immediately (load=${load})`, () => {
  const input = createProject('Frozen'), doc = new DocumentStore(input)
  if (load) doc.load(input)
  expect(doc.state).not.toBe(input)
  expect(Object.isFrozen(doc.state)).toBe(true)
  expect(Object.isFrozen(doc.state.timelines[doc.state.activeTimeline].tracks[0].clips)).toBe(true)
  expect(Object.isFrozen(input)).toBe(false)
})
