import { describe, expect, it } from 'vitest'
import type { Track } from './project'
import {
  CLIP_LEVEL, HOLD_MS, METER_FLOOR_DB, MIN_DB, anySolo, busGain, createMeterState, dbToFader, dbToGain, faderToDb, gainToDb, measureSamples, panStereo, resetClip, stepMeter, trackAudible
} from './audio-mix'

const track = (over: Partial<Track> = {}): Track => ({ id: 't', kind: 'audio', name: 'A1', hidden: false, muted: false, locked: false, clips: [], ...over })

describe('decibels', () => {
  it('converts both ways and treats the floor as silence', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
    expect(dbToGain(MIN_DB)).toBe(0)
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2)
    expect(gainToDb(0)).toBe(-Infinity)
  })
})

describe('pan law', () => {
  it('is the identity at center and folds to one side at the extremes', () => {
    expect(panStereo(0, 0.3, 0.7)).toEqual([expect.closeTo(0.3, 9), expect.closeTo(0.7, 9)])
    expect(panStereo(-1, 0.3, 0.7)).toEqual([expect.closeTo(1, 9), expect.closeTo(0, 9)])
    expect(panStereo(1, 0.3, 0.7)).toEqual([expect.closeTo(0, 9), expect.closeTo(1, 9)])
  })
  it('moves the image smoothly toward the panned side', () => {
    let last = panStereo(0, 1, 1)
    for (const p of [0.25, 0.5, 0.75, 1]) {
      const now = panStereo(p, 1, 1)
      expect(now[0]).toBeLessThan(last[0])
      expect(now[1]).toBeGreaterThan(last[1])
      last = now
    }
  })
})

describe('solo resolution', () => {
  const a = track({ id: 'a' }), b = track({ id: 'b', solo: true }), v = track({ id: 'v', kind: 'visual' })
  it('only audio tracks count as soloed', () => {
    expect(anySolo([a, v])).toBe(false)
    expect(anySolo([a, b])).toBe(true)
    expect(anySolo([a, track({ kind: 'visual', solo: true })])).toBe(false)
  })
  it('silences non-soloed audio tracks while any is soloed', () => {
    expect(trackAudible(a, false)).toBe(true)
    expect(trackAudible(a, true)).toBe(false)
    expect(trackAudible(b, true)).toBe(true)
    expect(trackAudible(v, true)).toBe(true)
  })
  it('mute beats solo', () => {
    expect(trackAudible(track({ solo: true, muted: true }), true)).toBe(false)
  })
  it('bus gain combines fader and audibility', () => {
    expect(busGain(track({ gain: -6 }), false)).toBeCloseTo(0.501, 3)
    expect(busGain(track({ gain: -6 }), true)).toBe(0)
    expect(busGain(track({ gain: -80 }), false)).toBe(0)
    expect(busGain(track({ gain: 40 }), false)).toBeCloseTo(dbToGain(12), 6)
  })
})

describe('fader mapping', () => {
  it('round-trips and spans the range', () => {
    expect(faderToDb(0)).toBe(MIN_DB)
    expect(faderToDb(1)).toBe(12)
    for (const db of [-60, -24, -6, 0, 6, 12]) expect(faderToDb(dbToFader(db))).toBeCloseTo(db, 6)
    expect(dbToFader(0)).toBeGreaterThan(dbToFader(-12))
  })
})

describe('meter ballistics', () => {
  const loud = { peak: [0.5, 0.25] as [number, number], rms: [0.35, 0.18] as [number, number] }
  it('measures peak and rms', () => {
    expect(measureSamples([0, 0.5, -1, 0.5])).toEqual({ peak: 1, rms: Math.sqrt((0.25 + 1 + 0.25) / 4) })
    expect(measureSamples([])).toEqual({ peak: 0, rms: 0 })
  })
  it('peak rises instantly and falls at a fixed rate', () => {
    let s = stepMeter(createMeterState(), loud, 16)
    expect(s.peak[0]).toBeCloseTo(-6.02, 1)
    s = stepMeter(s, null, 1000)
    expect(s.peak[0]).toBeCloseTo(-6.02 - 28, 0)
    for (let i = 0; i < 100; i++) s = stepMeter(s, null, 100)
    expect(s.peak[0]).toBe(METER_FLOOR_DB)
  })
  it('rms is smoothed, slower on release than attack', () => {
    const up = stepMeter(createMeterState(), loud, 60)
    expect(up.rms[0]).toBeGreaterThan(METER_FLOOR_DB)
    expect(up.rms[0]).toBeLessThan(-9)
    const down = stepMeter({ ...up, rms: [-9, -9] }, null, 60)
    expect(-9 - down.rms[0]).toBeLessThan(up.rms[0] - METER_FLOOR_DB)
  })
  it('hold sticks for HOLD_MS then falls', () => {
    let s = stepMeter(createMeterState(), loud, 16)
    const top = s.hold[0]
    for (let t = 0; t < HOLD_MS - 100; t += 50) s = stepMeter(s, null, 50)
    expect(s.hold[0]).toBe(top)
    for (let t = 0; t < 2000; t += 50) s = stepMeter(s, null, 50)
    expect(s.hold[0]).toBeLessThan(top - 5)
  })
  it('clip latches until reset', () => {
    let s = stepMeter(createMeterState(), { peak: [CLIP_LEVEL, 0.1], rms: [0.5, 0.05] }, 16)
    expect(s.clip).toEqual([true, false])
    s = stepMeter(s, null, 5000)
    expect(s.clip[0]).toBe(true)
    expect(resetClip(s).clip).toEqual([false, false])
  })
})
