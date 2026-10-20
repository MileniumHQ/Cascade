import { describe, expect, it } from 'vitest'
import { clipEnd, type Clip, type Id, type Timeline, type Track } from '@shared/project'
import { FLICKS, secondsToFlicks, type Flicks } from '@shared/time'
import {
  MIN_CLIP,
  clearRange,
  clipAt,
  deleteClips,
  expandLinked,
  moveClips,
  placeClip,
  snapTime,
  splitClip,
  trimClip
} from './timeline-ops'

const sec = (s: number): Flicks => secondsToFlicks(s)

function makeClip(over: Partial<Clip> & Pick<Clip, 'id' | 'start' | 'duration'>): Clip {
  return {
    type: 'video',
    name: over.id,
    sourceIn: 0,
    properties: [],
    data: {},
    ...over
  }
}

function makeTrack(id: string, clips: Clip[]): Track {
  return { id, kind: 'visual', name: id, hidden: false, muted: false, locked: false, clips }
}

function makeTimeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'TL', tracks, markers: [] }
}

function kf(id: string, t: Flicks, value: number) {
  return { id, t, value, easing: { id: 'linear' } }
}

describe('clearRange', () => {
  it('removes clips fully inside the range and leaves clips outside it', () => {
    const before = makeClip({ id: 'before', start: 0, duration: sec(2), sourceIn: sec(4) })
    const inside = makeClip({ id: 'inside', start: sec(2), duration: sec(2) })
    const also = makeClip({ id: 'also', start: sec(4), duration: sec(1) })
    const after = makeClip({ id: 'after', start: sec(6), duration: sec(2), sourceIn: sec(9) })
    const track = makeTrack('v1', [before, inside, also, after])

    const { removed, created } = clearRange(track, sec(2), sec(5))

    expect(removed).toEqual(['inside', 'also'])
    expect(created).toEqual([])
    expect(track.clips.map((c) => c.id)).toEqual(['before', 'after'])
    expect(before).toMatchObject({ start: 0, duration: sec(2), sourceIn: sec(4) })
    expect(after).toMatchObject({ start: sec(6), duration: sec(2), sourceIn: sec(9) })
  })

  it('trims a partial overlap on the left without moving sourceIn', () => {
    const clip = makeClip({
      id: 'a',
      start: sec(1),
      duration: sec(8),
      sourceIn: sec(3),
      speed: 2,
      properties: [
        {
          id: 'p',
          type: 'opacity',
          enabled: true,
          params: { amount: { value: 0, keyframes: [kf('k', sec(2), 10)] } }
        }
      ]
    })
    const track = makeTrack('v1', [clip])

    clearRange(track, sec(5), sec(20))

    expect(track.clips).toEqual([clip])
    expect(clip.start).toBe(sec(1))
    expect(clip.duration).toBe(sec(4))
    expect(clipEnd(clip)).toBe(sec(5))
    expect(clip.sourceIn).toBe(sec(3))
    expect(clip.properties[0].params.amount.keyframes?.[0].t).toBe(sec(2))
  })

  it('trims a partial overlap on the right and shifts sourceIn by delta * speed', () => {
    for (const speed of [2, 0.5]) {
      const clip = makeClip({
        id: 'a',
        start: sec(4),
        duration: sec(10),
        sourceIn: sec(1),
        speed,
        properties: [
          {
            id: 'p',
            type: 'opacity',
            enabled: true,
            params: { amount: { value: 0, keyframes: [kf('k', sec(3), 7)] } }
          }
        ]
      })
      const track = makeTrack('v1', [clip])
      clearRange(track, 0, sec(6))

      const delta = sec(6) - sec(4)
      expect(clip.start).toBe(sec(6))
      expect(clip.duration).toBe(sec(8))
      expect(clip.sourceIn).toBe(sec(1) + delta * speed)
      // Keyframes are timeline-local, so they move by the trim delta and not by speed.
      expect(clip.properties[0].params.amount.keyframes?.[0].t).toBe(sec(3) - delta)
    }
  })

  it('splits a clip that spans the range and gives the right half a new id', () => {
    const speed = 2
    const sourceIn = sec(1)
    const clip = makeClip({
      id: 'span',
      start: 0,
      duration: sec(10),
      sourceIn,
      speed,
      linkId: 'link-1'
    })
    const track = makeTrack('v1', [clip])
    const start = sec(3)
    const end = sec(7)

    const { removed, created } = clearRange(track, start, end)

    expect(removed).toEqual([])
    expect(created).toHaveLength(1)
    const right = created[0]
    expect(track.clips).toEqual([clip, right])
    expect(clip.id).toBe('span')
    expect(clip.start).toBe(0)
    expect(clip.duration).toBe(start)
    expect(clip.sourceIn).toBe(sourceIn)
    expect(clip.linkId).toBe('link-1')

    expect(right.id).not.toBe(clip.id)
    expect(right.start).toBe(end)
    expect(right.duration).toBe(sec(10) - end)
    // Right half continues at the end of the hole, i.e. `end` along the original clip.
    const offset = end - 0
    expect(right.sourceIn).toBe(sourceIn + offset * speed)
    expect(right.linkId).toBeUndefined()
  })

  it('does not touch a clip listed in except', () => {
    const keep = makeClip({ id: 'keep', start: sec(1), duration: sec(4), sourceIn: sec(2) })
    const drop = makeClip({ id: 'drop', start: sec(1), duration: sec(1) })
    const track = makeTrack('v1', [keep, drop])

    const { removed } = clearRange(track, 0, sec(10), new Set<Id>(['keep']))

    expect(removed).toEqual(['drop'])
    expect(track.clips).toEqual([keep])
    expect(keep.duration).toBe(sec(4))
    expect(keep.sourceIn).toBe(sec(2))
  })

  it('treats the range as half-open', () => {
    const left = makeClip({ id: 'left', start: 0, duration: sec(2) })
    const right = makeClip({ id: 'right', start: sec(5), duration: sec(2) })
    const track = makeTrack('v1', [left, right])
    clearRange(track, sec(2), sec(5))
    expect(track.clips).toEqual([left, right])
  })
})

describe('placeClip', () => {
  it('overwrites the destination: trims, removes, and splits what is underneath', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(10), sourceIn: sec(2), speed: 2 })
    const b = makeClip({ id: 'b', start: sec(10), duration: sec(2) })
    const c = makeClip({ id: 'c', start: sec(14), duration: sec(6), sourceIn: sec(1), speed: 2 })
    const track = makeTrack('v1', [a, b, c])
    const placed = makeClip({ id: 'd', start: sec(8), duration: sec(8), sourceIn: sec(5) })

    const { removed } = placeClip(track, placed)

    expect(removed).toEqual(['b'])
    expect(track.clips.map((c) => c.id)).toEqual(['a', 'd', 'c'])
    expect(a).toMatchObject({ start: 0, duration: sec(8), sourceIn: sec(2) })
    expect(placed).toMatchObject({ start: sec(8), duration: sec(8) })
    expect(c.start).toBe(sec(16))
    expect(c.duration).toBe(sec(4))
    expect(c.sourceIn).toBe(sec(1) + (sec(16) - sec(14)) * 2)
  })

  it('clamps a negative start to 0 and inserts in start order', () => {
    const later = makeClip({ id: 'later', start: sec(5), duration: sec(2) })
    const track = makeTrack('v1', [later])
    const placed = makeClip({ id: 'early', start: sec(-3), duration: sec(2) })

    placeClip(track, placed)

    expect(placed.start).toBe(0)
    expect(track.clips.map((c) => c.id)).toEqual(['early', 'later'])
  })
})

describe('splitClip', () => {
  it('moves a keyframe at local 2s to local 1s on the right half when split at 1s', () => {
    const clip = makeClip({
      id: 'a',
      start: 0,
      duration: sec(5),
      sourceIn: sec(3),
      speed: 1,
      properties: [
        {
          id: 'p',
          type: 'opacity',
          enabled: true,
          params: {
            amount: {
              value: 0,
              keyframes: [kf('early', sec(0.5), 1), kf('late', sec(2), 10)]
            }
          }
        }
      ]
    })
    const track = makeTrack('v1', [clip])

    const right = splitClip(track, 'a', sec(1))

    expect(right).not.toBeNull()
    expect(track.clips).toEqual([clip, right])
    expect(clip.duration).toBe(sec(1))
    expect(clip.sourceIn).toBe(sec(3))
    const leftKeys = clip.properties[0].params.amount.keyframes!
    expect(leftKeys.map((k) => k.t)).toEqual([sec(0.5), sec(2)])

    expect(right!.id).not.toBe('a')
    expect(right!.start).toBe(sec(1))
    expect(right!.duration).toBe(sec(4))
    expect(right!.sourceIn).toBe(sec(3) + sec(1))
    const rightKeys = right!.properties[0].params.amount.keyframes!
    expect(rightKeys.find((k) => k.value === 10)!.t).toBe(sec(1))
    expect(rightKeys.find((k) => k.value === 1)!.t).toBe(sec(0.5) - sec(1))
    expect(rightKeys.every((k) => !leftKeys.some((l) => l.id === k.id))).toBe(true)
    rightKeys[1].value = 999
    expect(leftKeys[1].value).toBe(10)
  })

  it('shifts sourceIn by the local split offset times speed when the clip does not start at 0', () => {
    const clip = makeClip({
      id: 'a',
      start: sec(10),
      duration: sec(5),
      sourceIn: sec(3),
      speed: 2
    })
    const track = makeTrack('v1', [clip])
    const right = splitClip(track, 'a', sec(11))
    expect(right).toMatchObject({
      start: sec(11),
      duration: sec(4),
      sourceIn: sec(3) + sec(1) * 2
    })
  })

  it('rejects a split on the edge, inside the minimum margin, or on a missing id', () => {
    const clip = makeClip({ id: 'a', start: sec(2), duration: sec(4), sourceIn: sec(1) })
    const track = makeTrack('v1', [clip])
    const before = { ...clip }

    expect(splitClip(track, 'missing', sec(3))).toBeNull()
    expect(splitClip(track, 'a', clip.start)).toBeNull()
    expect(splitClip(track, 'a', clipEnd(clip))).toBeNull()
    expect(splitClip(track, 'a', clip.start + MIN_CLIP / 2)).toBeNull()
    expect(splitClip(track, 'a', clipEnd(clip) - MIN_CLIP / 2)).toBeNull()
    expect(track.clips).toHaveLength(1)
    expect(clip).toMatchObject(before)

    const right = splitClip(track, 'a', clip.start + MIN_CLIP / 2 + 1)
    expect(right).not.toBeNull()
    expect(track.clips).toHaveLength(2)
  })
})

describe('trimClip', () => {
  it('clamps the start and end to neighbouring clips', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(10) })
    const b = makeClip({ id: 'b', start: sec(10), duration: sec(10), sourceIn: sec(2), speed: 1 })
    const c = makeClip({ id: 'c', start: sec(20), duration: sec(10) })
    const track = makeTrack('v1', [a, b, c])

    trimClip(track, 'b', 'start', sec(5))
    expect(b.start).toBe(sec(10))
    expect(b.sourceIn).toBe(sec(2))

    trimClip(track, 'b', 'start', sec(12))
    expect(b.start).toBe(sec(12))
    expect(b.duration).toBe(sec(8))
    expect(b.sourceIn).toBe(sec(2) + sec(2))

    trimClip(track, 'b', 'end', sec(25))
    expect(clipEnd(b)).toBe(sec(20))
    expect(b.sourceIn).toBe(sec(4))

    trimClip(track, 'b', 'end', sec(16))
    expect(clipEnd(b)).toBe(sec(16))
    expect(b.duration).toBe(sec(4))
    expect(b.sourceIn).toBe(sec(4))
  })

  it('refuses to shrink a clip below MIN_CLIP', () => {
    expect(MIN_CLIP).toBe(FLICKS / 240)
    const clip = makeClip({ id: 'a', start: 0, duration: sec(2), sourceIn: sec(1) })
    const track = makeTrack('v1', [clip])

    trimClip(track, 'a', 'start', sec(2))
    expect(clip.duration).toBe(MIN_CLIP)
    expect(clip.start).toBe(sec(2) - MIN_CLIP)
    expect(clip.sourceIn).toBe(sec(1) + (clip.start - 0))

    const endClip = makeClip({ id: 'b', start: sec(5), duration: sec(2), sourceIn: sec(3) })
    const endTrack = makeTrack('v1', [endClip])
    trimClip(endTrack, 'b', 'end', sec(5))
    expect(endClip.start).toBe(sec(5))
    expect(endClip.duration).toBe(MIN_CLIP)
    expect(endClip.sourceIn).toBe(sec(3))
  })

  it('clamps to the source media, scaling the available media by speed', () => {
    const speed = 2
    const clip = makeClip({
      id: 'a',
      start: sec(10),
      duration: sec(2),
      sourceIn: sec(4),
      speed
    })
    const track = makeTrack('v1', [clip])
    const sourceDuration = sec(10)

    trimClip(track, 'a', 'start', 0, { sourceDuration })
    // Earliest timeline start that still has source: 10s - 4s/2 = 8s, sourceIn 0.
    expect(clip.start).toBe(sec(8))
    expect(clip.sourceIn).toBe(0)
    expect(clip.duration).toBe(sec(4))

    trimClip(track, 'a', 'end', sec(100), { sourceDuration })
    // Remaining source is 10s at 2x, so the end can reach 8s + 5s = 13s.
    expect(clipEnd(clip)).toBe(sec(13))
    expect(clip.sourceIn).toBe(0)

    const blocked = makeClip({ id: 'b', start: sec(5), duration: sec(2), sourceIn: 0, speed: 1 })
    trimClip(makeTrack('v1', [blocked]), 'b', 'start', 0, { sourceDuration: sec(20) })
    expect(blocked.start).toBe(sec(5))
    expect(blocked.sourceIn).toBe(0)
  })

  it('ignores an unknown clip id', () => {
    const clip = makeClip({ id: 'a', start: 0, duration: sec(2) })
    const track = makeTrack('v1', [clip])
    trimClip(track, 'nope', 'end', sec(10))
    expect(clip.duration).toBe(sec(2))
  })
})

describe('deleteClips', () => {
  it('shifts later clips on the same track by each removed duration when rippling', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(5) })
    const b = makeClip({ id: 'b', start: sec(15), duration: sec(4) })
    const c = makeClip({ id: 'c', start: sec(20), duration: sec(3) })
    const other = makeClip({ id: 'other', start: sec(15), duration: sec(4) })
    const v1 = makeTrack('v1', [a, b, c])
    const v2 = makeTrack('v2', [other])

    deleteClips(makeTimeline([v1, v2]), new Set(['a']), true)

    // The 10s gap is preserved: B moves left by A's duration, not all the way to 0.
    expect(b.start).toBe(sec(10))
    expect(c.start).toBe(sec(15))
    expect(other.start).toBe(sec(15))

    deleteClips(makeTimeline([v1, v2]), new Set(['b']), true)
    expect(a.start).toBe(0)
    expect(c.start).toBe(sec(11))
  })

  it('closes every removed clip from right to left when several are deleted', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(10) })
    const b = makeClip({ id: 'b', start: sec(10), duration: sec(4) })
    const c = makeClip({ id: 'c', start: sec(16), duration: sec(3) })
    const track = makeTrack('v1', [a, b, c])
    deleteClips(makeTimeline([track]), new Set(['a', 'b']), true)
    expect(track.clips.map((c) => c.id)).toEqual(['c'])
    expect(c.start).toBe(sec(2))
  })

  it('leaves later clips where they are when ripple is off', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(5) })
    const b = makeClip({ id: 'b', start: sec(5), duration: sec(5) })
    const track = makeTrack('v1', [a, b])
    deleteClips(makeTimeline([track]), new Set(['a']), false)
    expect(track.clips).toEqual([b])
    expect(b.start).toBe(sec(5))
  })
})

describe('moveClips', () => {
  it('moves onto another track and overwrites what is there', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(5), sourceIn: sec(1) })
    // Ends where the moved clip ends, so the overlap is a trim and not a split.
    const b = makeClip({ id: 'b', start: 0, duration: sec(8), sourceIn: sec(2), speed: 2 })
    const v1 = makeTrack('v1', [a])
    const v2 = makeTrack('v2', [b])

    moveClips(makeTimeline([v1, v2]), [{ clipId: 'a', start: sec(3), trackId: 'v2' }])

    expect(v1.clips).toEqual([])
    expect(v2.clips.map((c) => c.id)).toEqual(['b', 'a'])
    expect(b).toMatchObject({ start: 0, duration: sec(3), sourceIn: sec(2) })
    expect(a).toMatchObject({ start: sec(3), duration: sec(5), sourceIn: sec(1) })
  })

  it('splits a destination clip the move lands in the middle of', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(4), sourceIn: 0 })
    const b = makeClip({ id: 'b', start: 0, duration: sec(20), sourceIn: sec(1), speed: 2 })
    const v1 = makeTrack('v1', [a])
    const v2 = makeTrack('v2', [b])

    moveClips(makeTimeline([v1, v2]), [{ clipId: 'a', start: sec(6), trackId: 'v2' }])

    expect(v2.clips.map((c) => [c.id, c.start, c.duration, c.sourceIn])).toEqual([
      ['b', 0, sec(6), sec(1)],
      ['a', sec(6), sec(4), 0],
      [v2.clips[2].id, sec(10), sec(10), sec(1) + sec(10) * 2]
    ])
    expect(v2.clips[2].id).not.toBe('b')
  })

  it('lifts the clip before placing it, so a same-track move can overlap its old span', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(4) })
    const b = makeClip({ id: 'b', start: sec(4), duration: sec(4) })
    const track = makeTrack('v1', [a, b])

    moveClips(makeTimeline([track]), [{ clipId: 'b', start: sec(1), trackId: 'v1' }])

    expect(track.clips.map((c) => c.id)).toEqual(['a', 'b'])
    expect(a).toMatchObject({ start: 0, duration: sec(1) })
    expect(b).toMatchObject({ start: sec(1), duration: sec(4) })
  })

  it('clamps a negative destination start to 0', () => {
    const clip = makeClip({ id: 'a', start: sec(4), duration: sec(2) })
    const track = makeTrack('v1', [clip])
    moveClips(makeTimeline([track]), [{ clipId: 'a', start: sec(-8), trackId: 'v1' }])
    expect(clip.start).toBe(0)
  })
})

describe('expandLinked', () => {
  it('includes every clip that shares a linkId with the selection, and the selection itself', () => {
    const a = makeClip({ id: 'a', start: 0, duration: sec(1), linkId: 'L' })
    const b = makeClip({ id: 'b', start: 0, duration: sec(1), linkId: 'L' })
    const c = makeClip({ id: 'c', start: sec(2), duration: sec(1), linkId: 'M' })
    const d = makeClip({ id: 'd', start: sec(2), duration: sec(1) })
    const e = makeClip({ id: 'e', start: 0, duration: sec(1), linkId: 'L' })
    const tl = makeTimeline([makeTrack('v1', [a, c]), makeTrack('v2', [b, d]), makeTrack('a1', [e])])

    expect(expandLinked(tl, ['a'])).toEqual(new Set(['a', 'b', 'e']))
    expect(expandLinked(tl, ['d'])).toEqual(new Set(['d']))
    expect(expandLinked(tl, ['c', 'd'])).toEqual(new Set(['c', 'd']))
    expect(expandLinked(tl, ['missing'])).toEqual(new Set(['missing']))
    expect(expandLinked(tl, ['b', 'c'])).toEqual(new Set(['a', 'b', 'e', 'c']))
  })
})

describe('clipAt', () => {
  it('binary-searches a sorted track of 1000 clips, including both edges of each clip', () => {
    const span = FLICKS
    const clips: Clip[] = []
    for (let i = 0; i < 1000; i++) {
      clips.push(makeClip({ id: `c${i}`, start: i * span, duration: span }))
    }
    const track = makeTrack('v1', clips)

    expect(clipAt(track, 0)).toBe(clips[0])
    expect(clipAt(track, 500 * span + 10)).toBe(clips[500])
    expect(clipAt(track, 1000 * span - 1)).toBe(clips[999])
    expect(clipAt(track, 1000 * span)).toBeUndefined()
    expect(clipAt(track, -1)).toBeUndefined()
    expect(clipAt(makeTrack('empty', []), 0)).toBeUndefined()

    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const atStart = clipAt(track, c.start)
      const atLast = clipAt(track, c.start + c.duration - 1)
      const atEnd = clipAt(track, c.start + c.duration)
      if (atStart !== c || atLast !== c || atEnd !== clips[i + 1]) {
        throw new Error(
          `clip ${i}: start→${atStart?.id} last→${atLast?.id} end→${atEnd?.id} expected next ${clips[i + 1]?.id}`
        )
      }
    }
  })
})

describe('snapTime', () => {
  const points = [0, 100, 200]

  it('snaps to the nearest point within the threshold, inclusive of the threshold', () => {
    expect(snapTime(105, points, 10)).toEqual({ t: 100, snapped: true, to: 100 })
    expect(snapTime(190, points, 10)).toEqual({ t: 200, snapped: true, to: 200 })
    expect(snapTime(100, points, 0)).toEqual({ t: 100, snapped: true, to: 100 })
    expect(snapTime(110, points, 10)).toEqual({ t: 100, snapped: true, to: 100 })
  })

  it('keeps the original time when nothing is close enough', () => {
    expect(snapTime(150, points, 10)).toEqual({ t: 150, snapped: false })
    expect(snapTime(50, [], 100)).toEqual({ t: 50, snapped: false })
    expect(snapTime(1, points, 0)).toEqual({ t: 1, snapped: false })
  })

  it('prefers the later point when two candidates are equally close', () => {
    expect(snapTime(50, [0, 100], 50)).toEqual({ t: 100, snapped: true, to: 100 })
    expect(snapTime(102, [0, 100, 105], 10)).toEqual({ t: 100, snapped: true, to: 100 })
    expect(snapTime(104, [0, 100, 105], 10)).toEqual({ t: 105, snapped: true, to: 105 })
  })
})
