import { describe, expect, it } from 'vitest'
import { FLICKS, frameToFlicks } from '@shared/time'
import { cubicBezier } from '@core/evaluate'
import { curvePath, displayValue, fitBezier, groupByTime, plotRange, sampleEasing, snapTime, type KfItem } from './model'

const fps = { num: 30, den: 1 }

describe('snapTime', () => {
  const base = { fps, pxPerSecond: 100, targets: [] as number[], free: false }
  it('snaps to the frame grid', () => {
    const t = frameToFlicks(10, fps) + 1234
    expect(snapTime({ ...base, t }).t).toBe(frameToFlicks(10, fps))
  })
  it('prefers a target within 6px over the frame grid', () => {
    const target = frameToFlicks(10, fps) + Math.round(FLICKS * 0.01) // off-grid, 1px away at 100px/s
    const r = snapTime({ ...base, t: target + Math.round(FLICKS * 0.02), targets: [target] })
    expect(r).toEqual({ t: target, target })
  })
  it('ignores targets further than 6px', () => {
    const target = frameToFlicks(30, fps)
    const t = target + Math.round(FLICKS * 0.1) // 10px
    expect(snapTime({ ...base, t, targets: [target] }).target).toBeNull()
  })
  it('free (alt) keeps the raw time', () => {
    expect(snapTime({ ...base, t: 12345.4, free: true, targets: [12345] })).toEqual({ t: 12345, target: null })
  })
})

describe('groupByTime', () => {
  const item = (id: string, t: number, glyph: KfItem['glyph'] = 'diamond'): KfItem => ({
    id,
    t,
    glyph,
    easingId: 'linear',
    refs: [{ clipId: 'c', propertyId: 'p', paramId: id, keyframeId: id }]
  })
  it('merges keyframes at the same time and sorts', () => {
    const g = groupByTime([item('b', 10_000_000), item('a', 0), item('c', 10_000_000, 'circle')])
    expect(g.map((x) => x.t)).toEqual([0, 10_000_000])
    expect(g[1].refs).toHaveLength(2)
    expect(g[1].glyph).toBe('diamond') // mixed glyphs fall back to a diamond
  })
})

describe('easing sampling', () => {
  const linear = { id: 'linear', fn: (p: number) => p }
  it('samples endpoints', () => {
    const s = sampleEasing(linear, undefined, 10)
    expect(s[0]).toEqual({ p: 0, y: 0 })
    expect(s[10]).toEqual({ p: 1, y: 1 })
  })
  it('draws hold as a step at the end', () => {
    const s = sampleEasing({ id: 'hold', fn: () => 0 }, undefined, 4)
    expect(s.map((x) => x.y)).toEqual([0, 0, 0, 0, 1])
  })
  it('plot range always includes 0..1 and any overshoot', () => {
    expect(plotRange([{ y: 0.2 }], 0)).toEqual([0, 1])
    const [lo, hi] = plotRange([{ y: -0.3 }, { y: 1.4 }], 0)
    expect([lo, hi]).toEqual([-0.3, 1.4])
  })
  it('builds a path', () => {
    expect(curvePath([{ p: 0, y: 0 }, { p: 1, y: 1 }], 100, 50, [0, 1])).toBe('M0.00 50.00L100.00 0.00')
  })
})

describe('fitBezier', () => {
  it('recovers a bezier easing', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1)
    const fit = fitBezier(f)
    expect(fit.err).toBeLessThan(0.01)
  })
  it('flags a poor fit for a bounce', () => {
    const bounce = (p: number) => Math.abs(Math.sin(p * Math.PI * 4)) * (1 - p) + p * p
    expect(fitBezier(bounce).err).toBeGreaterThan(0.05)
  })
})

describe('displayValue', () => {
  const project = { settings: { width: 1920, height: 1080 } } as never
  it('shows frame fractions as px and percent as %', () => {
    expect(displayValue({ id: 'x', label: 'x', type: 'number', default: 0, unit: 'frameX' }, undefined, 0.5, project)).toBe('960px')
    expect(displayValue({ id: 'x', label: 'x', type: 'number', default: 0, unit: 'percent' }, undefined, 1.5, project)).toBe('150%')
    expect(displayValue({ id: 'p', label: 'p', type: 'vec2', default: [0, 0], unit: 'frameXY' }, undefined, [0.25, -0.1], project)).toBe('480, -108')
  })
})
