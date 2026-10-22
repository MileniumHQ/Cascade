import { describe, expect, it } from 'vitest'
import { clipEnd, type Clip, type Timeline, type Track } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { closeLinkedGap, insertTime, MIN_CLIP, rippleTrim, rollEdit, slideClip, slipClip, withTimeMaps } from './timeline-ops'
import { constantMap, curveMap, reverseMap, sourceSpan } from './time-remap'
import { createRegistries } from './app'
import { deleteWithRipple } from './advanced-editing'
const c = (id: string, start = 0, duration = 4 * S, sourceIn = 5 * S, linkId?: string): Clip => ({ id, name: id, type: 'custom', start, duration, sourceIn, linkId, properties: [], data: {} })
const tr = (id: string, clips: Clip[] = [], locked = false): Track => ({ id, kind: 'visual', name: id, clips, locked, hidden: false, muted: false })
const tl = (...tracks: Track[]): Timeline => ({ id: 'tl', name: 'tl', tracks, markers: [] })
const limits = () => ({ sourceDuration: 20 * S })

describe('ripple trim', () => {
  it('extends an end through the next clip, shifting its linked tail track', () => {
    const a = c('a'), b = c('b', 4 * S, 4 * S, 0, 'tail'), audio = c('audio', 4 * S, 4 * S, 0, 'tail')
    const t = tl(tr('v', [a, b]), tr('a', [audio]))
    expect(rippleTrim(t, 'a', 'end', 6 * S, { limits })).toBe(2 * S)
    expect(a.duration).toBe(6 * S)
    expect([b.start, audio.start]).toEqual([6 * S, 6 * S])
  })
  it('keeps a start at timeline zero while extending its source handles and rippling the tail', () => {
    const a = c('a'), b = c('b', 4 * S)
    const t = tl(tr('v', [a, b]))
    expect(rippleTrim(t, 'a', 'start', -2 * S, { limits })).toBe(-2 * S)
    expect(a).toMatchObject({ start: 0, duration: 6 * S, sourceIn: 3 * S })
    expect(b.start).toBe(6 * S)
    expect(rippleTrim(t, 'a', 'start', 100 * S, { limits })).toBe(6 * S - MIN_CLIP)
    expect(a.duration).toBe(MIN_CLIP)
    expect(b.start).toBe(MIN_CLIP)
  })
  it('clamps all linked members to the tightest handle and refuses a locked downstream partner', () => {
    const a = c('v', 0, 4 * S, 5 * S, 'L'), b = c('a', 0, 4 * S, 15 * S, 'L')
    const t = tl(tr('v', [a]), tr('a', [b]))
    expect(rippleTrim(t, 'v', 'end', 10 * S, { limits })).toBe(S)
    expect([a.duration, b.duration]).toEqual([5 * S, 5 * S])
    t.tracks[1].locked = true
    const before = JSON.stringify(t)
    expect(rippleTrim(t, 'v', 'end', 6 * S, { limits })).toBe(0)
    expect(JSON.stringify(t)).toBe(before)
  })
  it("uses each linked member's own tail boundary when members have different starts", () => {
    const a = c('v', 0, 4 * S, 5 * S, 'L'), b = c('a', 10 * S, 4 * S, 5 * S, 'L')
    const before = c('before', 4 * S, 6 * S)
    const t = tl(tr('v', [a, c('tail-v', 4 * S)]), tr('a', [before, b, c('tail-a', 14 * S)]))
    expect(rippleTrim(t, 'v', 'end', 5 * S, { limits })).toBe(S)
    expect(before.start).toBe(4 * S)
    expect(clipEnd(before)).toBe(b.start)
    expect(t.tracks[1].clips[2].start).toBe(15 * S)
  })
  it('limits reversed source handles and never collides with content on a tail partner track', () => {
    const a = c('v', 0, 4 * S, 5 * S), b = c('tail', 4 * S, 4 * S, 0, 'T'), other = c('other', 3 * S, S), partner = c('partner', 4 * S, 4 * S, 0, 'T')
    const t = tl(tr('v', [a, b]), tr('a', [other, partner]))
    withTimeMaps(() => reverseMap(constantMap(1)), () => {
      expect(rippleTrim(t, 'v', 'end', 10 * S, { limits })).toBe(S)
      expect(a.duration).toBe(5 * S)
      expect(rippleTrim(t, 'v', 'end', S, { limits })).toBe(-S)
      // Tail partner reaches the previous clip's end, blocking further shortening.
      expect(rippleTrim(t, 'v', 'end', S, { limits })).toBe(0)
    })
  })
})

describe('roll, slip, slide', () => {
  it('roll preserves outside edges and clamps to both source handles', () => {
    const a = c('left', 0, 4 * S, 16 * S), b = c('right', 4 * S, 5 * S, 2 * S)
    const track = tr('v', [a, b])
    expect(rollEdit(track, a.id, b.id, 8 * S, limits)).toBe(0)
    expect(rollEdit(track, a.id, b.id, S, limits)).toBe(-2 * S)
    expect(a.duration).toBe(2 * S)
    expect(b).toMatchObject({ start: 2 * S, duration: 7 * S, sourceIn: 0 })
    expect(clipEnd(b)).toBe(9 * S)
    b.start++
    const before = JSON.stringify(track)
    expect(rollEdit(track, a.id, b.id, 4 * S, limits)).toBe(0)
    expect(JSON.stringify(track)).toBe(before)
  })
  it('slips reversed content beneath fixed edges, limited by both source ends', () => {
    const clip = c('r', 3 * S, 4 * S, 10 * S)
    withTimeMaps(() => reverseMap(constantMap(2)), () => {
      expect(slipClip(clip, 10 * S, limits())).toBe(S)
      expect(clip.sourceIn).toBe(8 * S)
      expect(sourceSpan(clip, reverseMap(constantMap(2)))).toEqual({ lo: 0, hi: 8 * S })
      expect(slipClip(clip, -10 * S, limits())).toBe(-6 * S)
      expect(clip.sourceIn).toBe(20 * S)
      expect([clip.start, clip.duration]).toEqual([3 * S, 4 * S])
    })
  })
  it('slips using the integral of a speed ramp and leaves zero speed unchanged', () => {
    const clip = c('r', 0, 2 * S, 0)
    const map = curveMap(1, [{ id: 'k1', t: 0, value: 1, easing: { id: 'linear' } }, { id: 'k2', t: 2 * S, value: 3, easing: { id: 'linear' } }], createRegistries())
    withTimeMaps(() => map, () => {
      expect(slipClip(clip, S, limits())).toBeCloseTo(S, -1)
      expect(clip.sourceIn).toBe(1.5 * S)
    })
    withTimeMaps(() => constantMap(0), () => expect(slipClip(clip, S, limits())).toBe(0))
  })
  it('slides by trimming neighbours, preserving source of the moved clip and outside edges', () => {
    const a = c('left', 0, 4 * S), b = c('middle', 4 * S, 3 * S), d = c('right', 7 * S, 4 * S, S)
    const track = tr('v', [a, b, d])
    expect(slideClip(track, 'middle', -5 * S, limits)).toBe(-S)
    expect(b).toMatchObject({ start: 3 * S, duration: 3 * S, sourceIn: 5 * S })
    expect(a.duration).toBe(3 * S)
    expect(d).toMatchObject({ start: 6 * S, duration: 5 * S, sourceIn: 0 })
    expect(clipEnd(d)).toBe(11 * S)
    track.locked = true
    const before = JSON.stringify(track)
    expect(slideClip(track, 'middle', S, limits)).toBe(0)
    expect(JSON.stringify(track)).toBe(before)
    expect(slideClip(tr('v', [b]), 'middle', S)).toBe(0)
  })
})

describe('insert time and linked gap closure', () => {
  it('splits linked clips at an insertion and remaps right-half links together', () => {
    const a = c('v', 0, 4 * S, 2 * S, 'L'), b = c('a', 0, 4 * S, 2 * S, 'L')
    const t = tl(tr('v', [a]), tr('a', [b]))
    expect(insertTime(t, ['v'], S, 2 * S)).toBe(true)
    const right = t.tracks.map((tr) => tr.clips[1])
    expect(right.map((c) => [c.start, c.sourceIn, c.duration])).toEqual([[3 * S, 3 * S, 3 * S], [3 * S, 3 * S, 3 * S]])
    expect(right[0].linkId).toBe(right[1].linkId)
    expect(right[0].linkId).not.toBe('L')
    expect(a.linkId).toBe(b.linkId)
  })
  it('refuses a locked partner or an unsplittable edge without mutating', () => {
    const t = tl(tr('v', [c('v', 0, 4 * S, 0, 'L')]), tr('a', [c('a', 0, 4 * S, 0, 'L')], true))
    const before = JSON.stringify(t)
    expect(insertTime(t, ['v'], S, S)).toBe(false)
    expect(JSON.stringify(t)).toBe(before)
    t.tracks[1].locked = false
    expect(insertTime(t, ['v'], 1, S)).toBe(false)
    expect(t.tracks[0].clips).toHaveLength(1)
  })
  it('closes an identical empty interval on linked tail tracks, preserving offsets', () => {
    const t = tl(tr('v', [c('v', 5 * S, 4 * S, 0, 'L')]), tr('a', [c('a', 6 * S, 4 * S, 0, 'L')]))
    expect(closeLinkedGap(t, 'v', 2 * S)).toBe(true)
    expect(t.tracks.map((tr) => tr.clips[0].start)).toEqual([0, S])
    expect(closeLinkedGap(t, 'v', S)).toBe(false)
    expect(closeLinkedGap(t, 'v', 30 * S)).toBe(false)
  })
  it('refuses to consume content or move a locked linked tail', () => {
    const t = tl(tr('v', [c('v', 5 * S, 4 * S, 0, 'L')]), tr('a', [c('other', 0, S), c('a', 5 * S, 4 * S, 0, 'L')]))
    const before = JSON.stringify(t)
    expect(closeLinkedGap(t, 'v', S)).toBe(false)
    expect(JSON.stringify(t)).toBe(before)
    t.tracks[1].clips.shift()
    t.tracks[1].locked = true
    expect(closeLinkedGap(t, 'v', S)).toBe(false)
  })
  it('refuses a boundary between offset linked members instead of moving just one partner', () => {
    const t = tl(tr('v', [c('v', 10 * S, 2 * S, 0, 'L')]), tr('a', [c('a', 0, 2 * S, 0, 'L')]))
    const before = JSON.stringify(t)
    expect(insertTime(t, ['v'], 5 * S, S)).toBe(false)
    expect(closeLinkedGap(t, 'v', 5 * S)).toBe(false)
    expect(JSON.stringify(t)).toBe(before)
  })
  it("ripple delete uses each track's removed duration for overlapping selections", () => {
    const t = tl(tr('v', [c('gone-v', 0, 10 * S), c('tail-v', 20 * S, S, 0, 'L')]), tr('a', [c('gone-a', 5 * S, 10 * S), c('tail-a', 20 * S, S, 0, 'L')]))
    expect(deleteWithRipple(t, new Set(['gone-v', 'gone-a']))).toBe(true)
    expect(t.tracks.map((tr) => tr.clips[0].start)).toEqual([10 * S, 10 * S])
  })
})
