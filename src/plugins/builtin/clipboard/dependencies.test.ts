import { expect, it } from 'vitest'
import { createProject, createTimeline, findClip, type Clip, type TransitionInstance } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { captureClips, pasteClips, parseClipboard } from './clips'
import { CascadeApp } from '@core/app'
const clip = (id: string, start = 0): Clip => ({ id, type: 'missing', name: id, start, duration: S, sourceIn: 0, properties: [], data: {} })
const tx = (id: string, from?: string, to?: string): TransitionInstance => ({ id, type: 'unknown', from, to, duration: S / 2, align: 'center', params: { opaque: [1] }, linkId: 'pair' })
it('copy/paste and duplicate retain internal and single-ended transitions with fresh identities', () => {
  const p = createProject(''), tl = p.timelines[p.activeTimeline], track = tl.tracks[0]
  track.clips = [clip('a'), clip('b', S), clip('outside', 2*S)]
  track.transitions = [tx('in', undefined, 'a'), tx('ab', 'a', 'b'), tx('out', 'b'), tx('external', 'b', 'outside')]
  const payload = captureClips(p, ['a', 'b'])!
  expect(parseClipboard(JSON.stringify(payload))).toEqual(payload)
  const ids = pasteClips(p, payload, 5*S, track.id)!
  const copies = track.transitions!.filter(t => t.id !== 'in' && t.id !== 'ab' && t.id !== 'out' && t.id !== 'external')
  expect(copies).toHaveLength(3)
  expect(copies.map(t => [t.from, t.to])).toEqual([[undefined, ids[0]], [ids[0], ids[1]], [ids[1], undefined]])
  expect(new Set(copies.map(t => t.linkId)).size).toBe(1)
  expect(copies[0].linkId).not.toBe('pair')
  const a = new CascadeApp('editor', null, p)
  a.edit.duplicateClips(['a', 'b'])
  expect(a.timeline().tracks[0].transitions!.filter(t => !track.transitions!.some(old => old.id === t.id))).toHaveLength(3)
})
it('copies transitive timeline dependencies and remaps all instance identities across projects, reusing same-project timelines', () => {
  const p = createProject('source'), tl = p.timelines[p.activeTimeline]
  for (const id of ['child', 'grandchild']) {
    p.timelines[id] = { ...createTimeline(id), id }; p.timelineOrder.push(id)
    p.media[id] = { id, type: 'missing', name: id, timelineId: id, meta: {} }; p.mediaOrder.push(id)
  }
  tl.tracks[0].clips = [{ ...clip('wrapper'), mediaId: 'child' }]
  p.timelines.child.tracks[0].clips = [{ ...clip('nested'), mediaId: 'grandchild' }]
  p.timelines.grandchild.tracks[0].clips = [clip('leaf')]
  const payload = captureClips(p, ['wrapper'])!, dest = createProject('dest')
  const pasted = pasteClips(dest, payload, 0)!
  const wrapper = findClip(dest.timelines[dest.activeTimeline], pasted[0])!.clip
  const childId = dest.media[wrapper.mediaId!].timelineId!
  expect(childId).not.toBe('child')
  expect(dest.timelines[childId]).toBeDefined()
  const nested = dest.timelines[childId].tracks[0].clips[0]
  const grandchildId = dest.media[nested.mediaId!].timelineId!
  expect(dest.timelines[grandchildId].tracks[0].clips[0].id).not.toBe('leaf')
  expect(nested.id).not.toBe('nested')
  pasteClips(p, payload, 3*S)
  expect(p.timelineOrder).toHaveLength(3)
  expect(Object.values(p.media).filter(m => m.timelineId === 'child')).toHaveLength(1)
})
