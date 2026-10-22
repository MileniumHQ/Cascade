import { describe, expect, it } from 'vitest'
import { clipEnd, type Clip, type Timeline, type Track, type TrackKind } from '@shared/project'
import { secondsToFlicks, type Flicks } from '@shared/time'
import { endOfTracks, insertClips, overwriteClips, resolveRange, resolveTarget, type RangeRequest } from './three-point'

const sec = (s: number): Flicks => secondsToFlicks(s)

function clip(id: string, start: number, dur: number, over: Partial<Clip> = {}): Clip {
  return { id, type: 'video', name: id, start: sec(start), duration: sec(dur), sourceIn: 0, properties: [], data: {}, ...over }
}
function track(id: string, kind: TrackKind, clips: Clip[] = [], locked = false): Track {
  return { id, kind, name: id, hidden: false, muted: false, locked, clips }
}
const timeline = (tracks: Track[]): Timeline => ({ id: 'tl', name: 'TL', tracks, markers: [] })
const spans = (t: Track) => t.clips.map((c) => [c.id, c.start / sec(1), clipEnd(c) / sec(1)])

const req = (over: Partial<RangeRequest> = {}): RangeRequest => ({ sourceLength: sec(10), defaultSpan: sec(5), playhead: sec(20), ...over })
const r = (res: ReturnType<typeof resolveRange>) => res && { start: res.start / sec(1), duration: res.duration / sec(1), sourceIn: res.sourceIn / sec(1), fit: res.fit, shortened: res.shortened }

describe('resolveRange', () => {
  it('uses the whole source at the playhead when nothing is marked', () => {
    expect(r(resolveRange(req()))).toEqual({ start: 20, duration: 10, sourceIn: 0, fit: false, shortened: false })
  })

  it('takes the marked source range at the timeline in', () => {
    const res = resolveRange(req({ sourceIn: sec(2), sourceOut: sec(5), timelineIn: sec(7) }))
    expect(r(res)).toEqual({ start: 7, duration: 3, sourceIn: 2, fit: false, shortened: false })
  })

  it('treats only a source in as "to the end of the source"', () => {
    expect(r(resolveRange(req({ sourceIn: sec(4) })))).toMatchObject({ start: 20, duration: 6, sourceIn: 4 })
  })

  it('treats only a source out as "from the start of the source"', () => {
    expect(r(resolveRange(req({ sourceOut: sec(3) })))).toMatchObject({ duration: 3, sourceIn: 0 })
  })

  it('lets the timeline duration win when all four points are set', () => {
    const res = resolveRange(req({ sourceIn: sec(1), sourceOut: sec(9), timelineIn: sec(10), timelineOut: sec(13) }))
    expect(r(res)).toEqual({ start: 10, duration: 3, sourceIn: 1, fit: true, shortened: false })
  })

  it('fits from the source out when only the out is marked next to a timeline range', () => {
    const res = resolveRange(req({ sourceOut: sec(8), timelineIn: sec(10), timelineOut: sec(13) }))
    expect(r(res)).toMatchObject({ start: 10, duration: 3, sourceIn: 5, fit: true })
  })

  it('uses a timeline range with an unmarked source from the source start, without calling it a fit', () => {
    expect(r(resolveRange(req({ timelineIn: sec(10), timelineOut: sec(14) })))).toEqual({ start: 10, duration: 4, sourceIn: 0, fit: false, shortened: false })
  })

  it('backtimes from a timeline out with no timeline in', () => {
    const res = resolveRange(req({ sourceIn: sec(2), sourceOut: sec(6), timelineOut: sec(12) }))
    expect(r(res)).toMatchObject({ start: 8, duration: 4, sourceIn: 2 })
  })

  it('drops the head of the source when a backtimed edit would start before 0', () => {
    const res = resolveRange(req({ sourceIn: sec(1), sourceOut: sec(9), timelineOut: sec(5) }))
    expect(r(res)).toMatchObject({ start: 0, duration: 5, sourceIn: 4 })
  })

  it('shortens the clip when the source ends before the requested range', () => {
    const res = resolveRange(req({ sourceIn: sec(7), timelineIn: sec(0), timelineOut: sec(8) }))
    expect(r(res)).toEqual({ start: 0, duration: 3, sourceIn: 7, fit: false, shortened: true })
  })

  it('clamps marks to the media', () => {
    expect(r(resolveRange(req({ sourceIn: sec(-3), sourceOut: sec(50) })))).toMatchObject({ sourceIn: 0, duration: 10 })
  })

  it('ignores a source out at or before the in, and a timeline out at or before the in', () => {
    expect(r(resolveRange(req({ sourceIn: sec(5), sourceOut: sec(4) })))).toMatchObject({ sourceIn: 5, duration: 5 })
    expect(r(resolveRange(req({ timelineIn: sec(9), timelineOut: sec(9) })))).toMatchObject({ start: 9, duration: 10 })
  })

  it('returns null when the source in is at the end of the media', () => {
    expect(resolveRange(req({ sourceIn: sec(10) }))).toBeNull()
  })

  it('gives unbounded sources their default span, or the marked span', () => {
    expect(r(resolveRange(req({ sourceLength: null })))).toMatchObject({ duration: 5, sourceIn: 0 })
    expect(r(resolveRange(req({ sourceLength: null, sourceIn: sec(1), sourceOut: sec(3) })))).toMatchObject({ duration: 2, sourceIn: 0 })
    expect(r(resolveRange(req({ sourceLength: null, timelineIn: sec(2), timelineOut: sec(30) })))).toMatchObject({ start: 2, duration: 28 })
  })

  it('snaps the start and duration to the frame grid', () => {
    const snap = (t: Flicks) => Math.round(t / sec(0.5)) * sec(0.5)
    const res = resolveRange(req({ snap, sourceIn: sec(0), sourceOut: sec(2.2), playhead: sec(3.1) }))
    expect(r(res)).toMatchObject({ start: 3, duration: 2 })
  })
})

describe('overwriteClips', () => {
  it('replaces what the new clips cover on each track', () => {
    const v = track('v1', 'visual', [clip('a', 0, 10)])
    const a = track('a1', 'audio', [clip('b', 0, 10, { type: 'audio' })])
    const tl = timeline([v, a])
    const res = overwriteClips(tl, [
      { trackId: 'v1', clip: clip('n', 4, 2) },
      { trackId: 'a1', clip: clip('na', 4, 2, { type: 'audio' }) }
    ])
    expect(res.placed).toEqual(['n', 'na'])
    expect(v.clips.map((c) => [c.start / sec(1), clipEnd(c) / sec(1)])).toEqual([[0, 4], [4, 6], [6, 10]])
    expect(v.clips[1].id).toBe('n')
  })

  it('skips locked and unknown tracks and unlinks what is left alone', () => {
    const v = track('v1', 'visual')
    const a = track('a1', 'audio', [], true)
    const tl = timeline([v, a])
    const res = overwriteClips(tl, [
      { trackId: 'v1', clip: clip('n', 0, 2, { linkId: 'L' }) },
      { trackId: 'a1', clip: clip('na', 0, 2, { type: 'audio', linkId: 'L' }) },
      { trackId: 'nope', clip: clip('x', 0, 1) }
    ])
    expect(res.placed).toEqual(['n'])
    expect(res.blocked).toEqual(['na', 'x'])
    expect(v.clips[0].linkId).toBeUndefined()
    expect(a.clips).toHaveLength(0)
  })
})

describe('insertClips', () => {
  it('pushes later clips on the target track right', () => {
    const v = track('v1', 'visual', [clip('a', 0, 4), clip('b', 6, 4)])
    const tl = timeline([v])
    insertClips(tl, [{ trackId: 'v1', clip: clip('n', 4, 3) }], sec(4), sec(3))
    expect(spans(v)).toEqual([['a', 0, 4], ['n', 4, 7], ['b', 9, 13]])
  })

  it('splits a straddling clip and shifts the right half', () => {
    const v = track('v1', 'visual', [clip('a', 0, 10, { sourceIn: sec(100) })])
    const tl = timeline([v])
    const res = insertClips(tl, [{ trackId: 'v1', clip: clip('n', 4, 2) }], sec(4), sec(2))
    expect(res.split).toHaveLength(1)
    expect(spans(v)).toEqual([['a', 0, 4], ['n', 4, 6], [res.split[0], 6, 12]])
    expect(v.clips[2].sourceIn).toBe(sec(104))
  })

  it('inserts at the very start and the very end', () => {
    const v = track('v1', 'visual', [clip('a', 0, 4)])
    const tl = timeline([v])
    insertClips(tl, [{ trackId: 'v1', clip: clip('n', 0, 2) }], 0, sec(2))
    expect(spans(v)).toEqual([['n', 0, 2], ['a', 2, 6]])
    insertClips(tl, [{ trackId: 'v1', clip: clip('e', 6, 1) }], sec(6), sec(1))
    expect(spans(v)).toEqual([['n', 0, 2], ['a', 2, 6], ['e', 6, 7]])
  })

  it('ripples both targets of a linked video and audio pair and leaves earlier clips alone', () => {
    const v = track('v1', 'visual', [clip('v0', 0, 3), clip('va', 5, 5, { linkId: 'L' })])
    const a = track('a1', 'audio', [clip('a0', 0, 3, { type: 'audio' }), clip('aa', 5, 5, { type: 'audio', linkId: 'L' })])
    const tl = timeline([v, a])
    insertClips(tl, [
      { trackId: 'v1', clip: clip('nv', 3, 2) },
      { trackId: 'a1', clip: clip('na', 3, 2, { type: 'audio' }) }
    ], sec(3), sec(2))
    expect(spans(v)).toEqual([['v0', 0, 3], ['nv', 3, 5], ['va', 7, 12]])
    expect(spans(a)).toEqual([['a0', 0, 3], ['na', 3, 5], ['aa', 7, 12]])
  })

  it('moves link partners on an untargeted track so they stay in sync (video-only insert)', () => {
    const v = track('v1', 'visual', [clip('va', 0, 10, { linkId: 'L' })])
    const a = track('a1', 'audio', [clip('aa', 0, 10, { type: 'audio', linkId: 'L' })])
    const tl = timeline([v, a])
    const res = insertClips(tl, [{ trackId: 'v1', clip: clip('nv', 4, 2) }], sec(4), sec(2))
    // Both clips are cut at 4s and their right halves open the same gap, keeping the pair linked to each other.
    expect(spans(v).map((s) => s.slice(1))).toEqual([[0, 4], [4, 6], [6, 12]])
    expect(spans(a).map((s) => s.slice(1))).toEqual([[0, 4], [6, 12]])
    expect(res.split).toHaveLength(2)
    const vr = v.clips[2]
    const ar = a.clips[1]
    expect(vr.linkId).toBeDefined()
    expect(vr.linkId).toBe(ar.linkId)
    expect(vr.linkId).not.toBe('L')
    expect(v.clips[0].linkId).toBe('L')
    expect(a.clips[0].linkId).toBe('L')
  })

  it('does not ripple unrelated clips on untargeted tracks', () => {
    const v1 = track('v1', 'visual', [clip('a', 0, 10)])
    const v2 = track('v2', 'visual', [clip('over', 2, 6)])
    const tl = timeline([v1, v2])
    insertClips(tl, [{ trackId: 'v1', clip: clip('n', 4, 2) }], sec(4), sec(2))
    expect(spans(v2)).toEqual([['over', 2, 8]])
  })

  it('leaves locked tracks untouched, even for linked partners, and does not insert into them', () => {
    const v = track('v1', 'visual', [clip('va', 0, 10, { linkId: 'L' })])
    const a = track('a1', 'audio', [clip('aa', 0, 10, { type: 'audio', linkId: 'L' })], true)
    const tl = timeline([v, a])
    const res = insertClips(tl, [
      { trackId: 'v1', clip: clip('nv', 4, 2, { linkId: 'N' }) },
      { trackId: 'a1', clip: clip('na', 4, 2, { type: 'audio', linkId: 'N' }) }
    ], sec(4), sec(2))
    expect(res.blocked).toEqual(['na', 'nv'])
    expect(res.placed).toEqual([])
    expect(spans(a)).toEqual([['aa', 0, 10]])
    expect(spans(v)).toEqual([['va', 0, 10]])
  })

  it('only ripples audio when only the audio clip is placed', () => {
    const v = track('v1', 'visual', [clip('v', 0, 10)])
    const a = track('a1', 'audio', [clip('a', 0, 10, { type: 'audio' }), clip('b', 12, 2, { type: 'audio' })])
    const tl = timeline([v, a])
    insertClips(tl, [{ trackId: 'a1', clip: clip('na', 5, 1, { type: 'audio' }) }], sec(5), sec(1))
    expect(spans(v)).toEqual([['v', 0, 10]])
    expect(a.clips.map((c) => [c.start / sec(1), clipEnd(c) / sec(1)])).toEqual([[0, 5], [5, 6], [6, 11], [13, 15]])
  })
})

describe('endOfTracks / resolveTarget', () => {
  it('finds the furthest end across the given tracks', () => {
    const tl = timeline([track('v1', 'visual', [clip('a', 0, 4)]), track('a1', 'audio', [clip('b', 0, 9)]), track('v2', 'visual', [clip('c', 0, 30)])])
    expect(endOfTracks(tl, ['v1', 'a1'])).toBe(sec(9))
    expect(endOfTracks(tl, [])).toBe(0)
  })

  it('prefers the targeted track, else the first unlocked of that kind', () => {
    const tl = timeline([track('v1', 'visual', [], true), track('v2', 'visual'), track('v3', 'visual'), track('a1', 'audio')])
    expect(resolveTarget(tl, 'visual', 'v3')?.id).toBe('v3')
    expect(resolveTarget(tl, 'visual')?.id).toBe('v2')
    expect(resolveTarget(tl, 'visual', 'a1')?.id).toBe('v2')
    expect(resolveTarget(tl, 'audio', null)?.id).toBe('a1')
  })

  it('refuses a locked target and kinds with no free track', () => {
    const tl = timeline([track('v1', 'visual', [], true), track('a1', 'audio', [], true)])
    expect(resolveTarget(tl, 'visual', 'v1')).toBeUndefined()
    expect(resolveTarget(tl, 'audio')).toBeUndefined()
  })
})
