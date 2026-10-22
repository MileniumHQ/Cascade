import { describe, expect, test } from 'vitest'
import { createTimeline, type Clip, type Timeline } from '@shared/project'
import { FLICKS } from '@shared/time'
import { breakApart, cloneTimeline, nestClips, nestReason } from './nesting'
import { constantMap } from './time-remap'

const S = (n: number) => Math.round(n * FLICKS)
const clip = (id: string, start: number, duration = 2, linkId?: string): Clip => ({ id, type: 'unknown', name: id, start: S(start), duration: S(duration), sourceIn: S(1), linkId, properties: [], data: { plugin: { keep: true } } })
function fixture(): Timeline {
  const tl = createTimeline('Edit')
  tl.tracks[0].clips = [clip('v1', 4, 2, 'L'), clip('v2', 6)]
  tl.tracks[1].clips = [clip('title', 5, 1)]
  tl.tracks[3].clips = [clip('a1', 4, 2, 'L')]
  tl.tracks[3].gain = -6
  tl.tracks[3].pan = .3
  tl.tracks[0].transitions = [{ id: 'tx', type: 'unknown-transition', from: 'v1', to: 'v2', duration: S(1), align: 'center', params: { keep: 'me' } }]
  return tl
}

describe('nesting', () => {
  test('moves across tracks, expands links and preserves relative timing, bus state and transitions', () => {
    const tl = fixture(), wrapper = clip('wrapper', 0)
    const nested = nestClips(tl, ['v1', 'v2', 'title'], wrapper, 'nested', 'Nested')!
    expect(nested.tracks.map(t => t.clips.map(c => [c.id, c.start]))).toEqual([
      [['v1', 0], ['v2', S(2)]], [['title', S(1)]], [], [['a1', 0]], []
    ])
    expect(nested.tracks[3]).toMatchObject({ gain: -6, pan: .3 })
    expect(nested.tracks[0].transitions).toEqual([{ id: 'tx', type: 'unknown-transition', from: 'v1', to: 'v2', duration: S(1), align: 'center', params: { keep: 'me' } }])
    expect(tl.tracks[0].clips).toEqual([expect.objectContaining({ id: 'wrapper', start: S(4), duration: S(4), sourceIn: 0 })])
    expect(tl.tracks[3].clips).toEqual([])
    expect(tl.tracks[0].transitions).toEqual([])
    expect(nested.tracks[0].clips[0].data).toEqual({ plugin: { keep: true } })
  })
  test('refuses a partial transition, locked linked member, and unselected clips in the replacement span atomically', () => {
    const tl = fixture(), before = structuredClone(tl)
    expect(nestReason(tl, ['v1'])).toMatch(/both sides/)
    expect(nestClips(tl, ['v1'], clip('wrapper', 0), 'nested', 'N')).toBeNull()
    expect(tl).toEqual(before)
    tl.tracks[3].locked = true
    expect(nestReason(tl, ['v1', 'v2'])).toMatch(/Unlock/)
    tl.tracks[3].locked = false
    tl.tracks[0].transitions = []
    tl.tracks[0].clips.push(clip('outside', 9))
    tl.tracks[1].clips[0].duration = S(8)
    expect(nestReason(tl, ['v1', 'v2', 'title'])).toMatch(/other clips/)
  })
  test('audio-only selection receives a visual wrapper carrying the original audio', () => {
    const tl = createTimeline(), before = tl.tracks[0].id
    tl.tracks[3].clips = [clip('audio', 2)]
    const nested = nestClips(tl, ['audio'], clip('wrapper', 0), 'nested', 'N')!
    expect(tl.tracks[0].id).not.toBe(before)
    expect(tl.tracks[0].clips[0].start).toBe(S(2))
    expect(nested.tracks.find(t => t.kind === 'audio')!.clips[0].id).toBe('audio')
  })
})

test('clone rewrites every identity and link while preserving unknown plugin data', () => {
  const tl = fixture()
  tl.markers = [{ id: 'marker', t: S(3), name: 'M' }]
  tl.tracks[0].clips[0].properties = [{ id: 'p', type: 'unknown-effect', enabled: true, params: { amount: { value: 4, keyframes: [{ id: 'key', t: 0, value: 2, easing: { id: 'unknown-ease' } }] } } }]
  const clone = cloneTimeline(tl)
  expect(clone.id).not.toBe(tl.id)
  expect(clone.tracks[0].id).not.toBe(tl.tracks[0].id)
  const first = clone.tracks[0].clips[0]
  expect(first.id).not.toBe('v1')
  expect(first.linkId).toBe(clone.tracks[3].clips[0].linkId)
  expect(first.linkId).not.toBe('L')
  expect(first.properties[0].id).not.toBe('p')
  expect(first.properties[0].params.amount.keyframes![0].id).not.toBe('key')
  expect(clone.tracks[0].transitions![0]).toMatchObject({ from: first.id, to: clone.tracks[0].clips[1].id, params: { keep: 'me' } })
  expect(clone.markers[0].id).not.toBe('marker')
  expect(tl.tracks[0].clips[0].id).toBe('v1')
})

test('break apart crops trim, shifts keyframes/source through child maps, preserves links and never overwrites neighbours', () => {
  const source = fixture(), target = createTimeline()
  source.tracks[0].transitions = []
  source.tracks[0].clips[0].properties = [{ id: 'p', type: 'arbitrary', enabled: true, params: { x: { value: 1, keyframes: [{ id: 'k', t: S(1), value: 3, easing: { id: 'linear' } }] } } }]
  const wrapper = clip('wrapper', 20, 2)
  wrapper.sourceIn = S(5)
  target.tracks[0].clips = [wrapper, clip('neighbour', 24)]
  const before = structuredClone(source)
  const ids = breakApart(target, 'wrapper', source, () => constantMap(2))!
  expect(ids).toHaveLength(4)
  expect(target.tracks[0].clips.map(c => c.id)).toEqual(['neighbour'])
  const first = target.tracks[1].clips[0]
  expect(first).toMatchObject({ start: S(20), duration: S(1), sourceIn: S(3) })
  expect(first.properties[0].params.x.keyframes![0].t).toBe(0)
  const audio = target.tracks.find(t => t.kind === 'audio' && t.clips.length)!
  expect(first.linkId).toBe(audio.clips[0].linkId)
  expect(audio).toMatchObject({ gain: -6, pan: .3 })
  expect(source).toEqual(before)
})

test('break apart resolves nested solo locally and preserves an existing parent solo scope', () => {
  for (const parentSolo of [false, true]) {
    const source = createTimeline(), target = createTimeline()
    source.tracks[3].clips = [clip('soloed', 0)]
    source.tracks[3].solo = true
    source.tracks[4].clips = [clip('silent', 0)]
    target.tracks[3].solo = parentSolo
    const wrapper = clip('wrapper', 0)
    wrapper.sourceIn = 0
    target.tracks[0].clips = [wrapper]
    breakApart(target, 'wrapper', source)
    const added = target.tracks.filter(t => t.kind === 'audio' && t.clips.length)
    expect(added.map(t => t.muted)).toEqual([false, true])
    expect(added.map(t => t.solo)).toEqual([parentSolo, parentSolo])
  }
})
