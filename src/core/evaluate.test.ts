import { describe, expect, it } from 'vitest'
import type { Keyframe, ParamValue } from '@shared/project'
import { FLICKS } from '@shared/time'
import type { EasingContribution, ParamDef, ParamTypeContribution } from './plugin-api'
import { Registry } from './registry'
import { cubicBezier, evaluateParam, spring, type EvalRegistries } from './evaluate'

const sec = (s: number) => Math.round(s * FLICKS)

function kf(id: string, t: number, value: number, easing = 'linear'): Keyframe {
  return { id, t, value, easing: { id: easing } }
}

function setup() {
  const paramTypes = new Registry<ParamTypeContribution>('paramTypes')
  const easings = new Registry<EasingContribution>('easings')
  let interpolations = 0
  paramTypes.register(
    {
      id: 'number',
      editor: () => {},
      interpolate: (a: number, b: number, p: number) => {
        interpolations++
        return a + (b - a) * p
      }
    },
    'test',
    true
  )
  easings.register({ id: 'linear', name: 'Linear', fn: (p) => p }, 'test', true)
  // Returns 1 so a test can tell a real hold (left value) from "run this easing".
  easings.register({ id: 'hold', name: 'Hold', fn: () => 1 }, 'test', true)
  const regs: EvalRegistries = { paramTypes, easings }
  const def: ParamDef = { id: 'opacity', label: 'Opacity', type: 'number', default: -1 }
  return { regs, def, reads: () => interpolations }
}

describe('evaluateParam', () => {
  it('returns the stored value when there are no keyframes, and the default when there is no value', () => {
    const { regs, def, reads } = setup()
    expect(evaluateParam(regs, def, undefined, 0)).toBe(-1)
    expect(evaluateParam(regs, def, { value: 5 }, sec(1))).toBe(5)
    expect(evaluateParam(regs, def, { value: 7, keyframes: [] }, sec(1))).toBe(7)
    expect(evaluateParam(regs, def, { value: undefined }, 0)).toBe(-1)
    expect(reads()).toBe(0)
  })

  it('holds the first keyframe before it, the last after it, and lerps between them', () => {
    const { regs, def, reads } = setup()
    const pv: ParamValue = {
      value: 5,
      keyframes: [kf('a', 0, 0), kf('b', sec(1), 100), kf('c', sec(2), 40)]
    }

    expect(evaluateParam(regs, def, pv, sec(-1))).toBe(0)
    expect(evaluateParam(regs, def, pv, 0)).toBe(0)
    expect(reads()).toBe(0)

    expect(evaluateParam(regs, def, pv, sec(0.25))).toBe(25)
    expect(evaluateParam(regs, def, pv, sec(0.5))).toBe(50)
    expect(evaluateParam(regs, def, pv, sec(1))).toBe(100)
    expect(evaluateParam(regs, def, pv, sec(1.5))).toBe(70)
    expect(evaluateParam(regs, def, pv, sec(2))).toBe(40)
    expect(evaluateParam(regs, def, pv, sec(10))).toBe(40)
    expect(reads()).toBeGreaterThan(0)
  })

  it('uses the left keyframe when its easing is hold, and does not interpolate', () => {
    const { regs, def, reads } = setup()
    const pv: ParamValue = {
      value: 5,
      keyframes: [kf('a', 0, 0, 'hold'), kf('b', sec(1), 100, 'linear')]
    }
    expect(evaluateParam(regs, def, pv, sec(0.5))).toBe(0)
    expect(evaluateParam(regs, def, pv, sec(0.99))).toBe(0)
    expect(reads()).toBe(0)

    const linearThenHold: ParamValue = {
      value: 0,
      keyframes: [kf('a', 0, 0, 'linear'), kf('b', sec(1), 100, 'hold')]
    }
    expect(evaluateParam(regs, def, linearThenHold, sec(0.5))).toBe(50)
  })

  it('finds the right segment among many keyframes', () => {
    const { regs, def } = setup()
    const keyframes = [0, 2, 4, 6, 8].map((s, i) => kf(`k${i}`, sec(s), s * 10))
    const pv: ParamValue = { value: 0, keyframes }
    expect(evaluateParam(regs, def, pv, sec(5))).toBe(50)
    expect(evaluateParam(regs, def, pv, sec(7))).toBe(70)
    expect(evaluateParam(regs, def, pv, sec(6))).toBe(60)
    expect(evaluateParam(regs, def, pv, sec(8))).toBe(80)
  })

  it('falls back to linear progress when the easing id is not registered', () => {
    const { regs, def } = setup()
    const pv: ParamValue = {
      value: 0,
      keyframes: [kf('a', 0, 0, 'missing'), kf('b', sec(1), 100)]
    }
    expect(evaluateParam(regs, def, pv, sec(0.25))).toBe(25)
  })
})

describe('cubicBezier', () => {
  it('is symmetric and monotonic for cubic-bezier(0.42, 0, 0.58, 1)', () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBeCloseTo(0.5, 6)
    let prev = 0
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      const v = ease(p)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(ease(p) + ease(1 - p)).toBeCloseTo(1, 6)
      prev = v
    }
  })

  it('matches the identity for cubic-bezier(0, 0, 1, 1)', () => {
    const id = cubicBezier(0, 0, 1, 1)
    expect(id(0)).toBe(0)
    expect(id(1)).toBe(1)
    expect(id(-0.2)).toBe(0)
    expect(id(1.2)).toBe(1)
    let max = 0
    for (let i = 0; i <= 50; i++) {
      const p = i / 50
      max = Math.max(max, Math.abs(id(p) - p))
    }
    expect(max).toBeLessThan(1e-5)
  })
})

/** Analytic 0→1 step response, including the overdamped branch. */
function analyticSpring(stiffness: number, damping: number, mass: number, p: number) {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  const settle =
    zeta < 1
      ? 6.9 / (zeta * w0 || 1)
      : 6.9 / (w0 * (zeta - Math.sqrt(Math.max(0, zeta * zeta - 1))) || 1)
  const dur = Math.min(10, Math.max(0.2, settle))
  if (p <= 0) return 0
  if (p >= 1) return 1
  const t = p * dur
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
  }
  if (zeta > 1 + 1e-6) {
    const wd = w0 * Math.sqrt(zeta * zeta - 1)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cosh(wd * t) + ((zeta * w0) / wd) * Math.sinh(wd * t))
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
}

describe('spring', () => {
  it('starts at 0 and ends at 1', () => {
    for (const args of [
      [170, 26],
      [100, 1],
      [100, 20],
      [100, 100]
    ] as const) {
      const fn = spring(args[0], args[1])
      expect(fn(0)).toBe(0)
      expect(fn(-1)).toBe(0)
      expect(fn(1)).toBe(1)
      expect(fn(2)).toBe(1)
      expect(Number.isFinite(fn(0.5))).toBe(true)
    }
  })

  it('matches the underdamped and critically damped curves', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      expect(spring(100, 1)(p)).toBeCloseTo(analyticSpring(100, 1, 1, p), 6)
      expect(spring(100, 20)(p)).toBeCloseTo(analyticSpring(100, 20, 1, p), 6)
    }
  })

  it('follows the overdamped step response when zeta > 1', () => {
    // Regression (fixed): spring() computes an overdamped settling time when zeta >= 1, but the
    // sample itself always uses the critically damped formula
    // `1 - e^{-w t} (1 + w t)`. For stiffness 100, damping 100 (zeta = 5) that
    // is already ~0.99 at 10% of the segment; the overdamped solution is ~0.49.
    // Fix: when zeta > 1, with wd = w0 * sqrt(zeta^2 - 1),
    //   1 - exp(-zeta*w0*t) * (cosh(wd*t) + (zeta*w0/wd)*sinh(wd*t))
    const fn = spring(100, 100)
    for (const p of [0.05, 0.1, 0.2, 0.5]) {
      expect(fn(p)).toBeCloseTo(analyticSpring(100, 100, 1, p), 3)
    }
  })
})
