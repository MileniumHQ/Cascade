import { describe, expect, it } from 'vitest'
import type { Clip, Timeline, Track } from '@shared/project'
import { audioTargets, normalizedVolume } from './normalize'
import { duckKeyframes, speechSegments } from '@shared/ducking'

const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, type: 'audio', name: id, start: 0, duration: 100, sourceIn: 0, properties: [], data: {}, ...extra })
const track = (id: string, kind: Track['kind'], clips: Clip[]): Track => ({ id, kind, name: id, hidden: false, muted: false, locked: false, clips })
const tl = (tracks: Track[]): Timeline => ({ id: 'tl', name: 'tl', tracks, markers: [] })

describe('normalizedVolume', () => {
  it('reaches the target and rounds to 0.1 dB', () => {
    expect(normalizedVolume(-20, -14)).toBe(6)
    expect(normalizedVolume(-9.04, -14)).toBe(-5)
    expect(normalizedVolume(-9.07, -14)).toBe(-4.9)
  })
  it('stays inside the volume property range', () => {
    expect(normalizedVolume(-70, -14)).toBe(24)
    expect(normalizedVolume(10, -14)).toBe(-24)
    expect(normalizedVolume(30, -40)).toBe(-60)
  })
})

describe('audioTargets', () => {
  const t = tl([track('v', 'visual', [clip('pic', { type: 'video', linkId: 'L' })]), track('a', 'audio', [clip('snd', { linkId: 'L' }), clip('solo')])])
  it('maps a picture clip to its linked audio and keeps audio clips', () => {
    expect(audioTargets(t, ['pic']).map((x) => x.clip.id)).toEqual(['snd'])
    expect(audioTargets(t, ['solo', 'pic']).map((x) => x.clip.id)).toEqual(['solo', 'snd'])
  })
  it('drops duplicates and unknown or unlinked clips', () => {
    expect(audioTargets(t, ['pic', 'snd', 'nope']).map((x) => x.clip.id)).toEqual(['snd'])
    expect(audioTargets(tl([track('v', 'visual', [clip('x', { type: 'video' })])]), ['x'])).toEqual([])
  })
})

describe('ducking', () => {
  it('merges speech across short gaps', () => {
    const words = [{ start: 0, end: 10 }, { start: 15, end: 20 }, { start: 100, end: 110 }]
    expect(speechSegments(words, 10)).toEqual([[0, 20], [100, 110]])
    expect(speechSegments(words, 3)).toEqual([[0, 10], [15, 20], [100, 110]])
  })
  it('dips under speech and recovers, relative to the base volume', () => {
    const keys = duckKeyframes([[300, 500]], { start: 0, duration: 1000 }, -3, { amount: -12, attack: 50, release: 100 })
    expect(keys).toEqual([{ t: 250, v: -3 }, { t: 300, v: -15 }, { t: 500, v: -15 }, { t: 600, v: -3 }])
  })
  it('starts ducked when speech is already under way and clamps at the clip end', () => {
    const keys = duckKeyframes([[-50, 900]], { start: 0, duration: 1000 }, 0, { amount: -12, attack: 50, release: 400 })
    expect(keys[0]).toEqual({ t: 0, v: -12 })
    expect(keys.at(-1)).toEqual({ t: 1000, v: 0 })
  })
  it('skips segments that do not touch the clip and never goes below -60 dB', () => {
    expect(duckKeyframes([[5000, 6000]], { start: 0, duration: 1000 }, 0, { amount: -12, attack: 50, release: 100 })).toEqual([])
    expect(duckKeyframes([[10, 20]], { start: 0, duration: 100 }, -55, { amount: -30, attack: 0, release: 0 }).some((k) => k.v < -60)).toBe(false)
  })
  it('keeps overlapping fades down instead of bouncing', () => {
    const keys = duckKeyframes([[100, 200], [220, 300]], { start: 0, duration: 1000 }, 0, { amount: -10, attack: 50, release: 100 })
    expect(keys.map((k) => k.v)).toEqual([0, -10, -10, 0])
    expect(keys.at(-1)!.t).toBe(400)
  })
})
