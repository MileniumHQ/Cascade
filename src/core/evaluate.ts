import type { Clip, Keyframe, ParamValue, PropertyInstance } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { EasingContribution, ParamDef, ParamTypeContribution, PropertyContribution } from './plugin-api'
import type { Registry } from './registry'

export interface EvalRegistries {
  paramTypes: Registry<ParamTypeContribution>
  easings: Registry<EasingContribution>
}

const linear = (p: number) => p

export function easeProgress(regs: EvalRegistries, kf: Keyframe, p: number): number {
  const e = regs.easings.get(kf.easing?.id ?? 'linear')
  if (!e) return linear(p)
  const params = kf.easing.params ?? e.params?.map((x) => x.default) ?? []
  return e.fn(Math.min(1, Math.max(0, p)), params)
}

/** Find the keyframe segment for `t`. Keyframes must be sorted by t. */
export function segmentAt(kfs: Keyframe[], t: Flicks): { a: Keyframe; b?: Keyframe; p: number } {
  if (t <= kfs[0].t) return { a: kfs[0], p: 0 }
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return { a: last, p: 0 }
  // binary search
  let lo = 0
  let hi = kfs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (kfs[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = kfs[lo]
  const b = kfs[hi]
  return { a, b, p: (t - a.t) / (b.t - a.t) }
}

export function evaluateParam(regs: EvalRegistries, def: ParamDef, pv: ParamValue | undefined, t: Flicks): unknown {
  if (!pv) return def.default
  const kfs = pv.keyframes
  if (!kfs || kfs.length === 0) return pv.value ?? def.default
  const { a, b, p } = segmentAt(kfs, t)
  if (!b) return a.value
  const type = regs.paramTypes.get(def.type)
  if (!type?.interpolate || a.easing?.id === 'hold') return a.value
  const e = easeProgress(regs, a, p)
  return type.interpolate(a.value, b.value, e)
}

export function evaluateProperty(
  regs: EvalRegistries,
  contribution: PropertyContribution,
  inst: PropertyInstance,
  t: Flicks
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of contribution.params) out[def.id] = evaluateParam(regs, def, inst.params[def.id], t)
  return out
}

export function defaultParams(contribution: PropertyContribution): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {}
  for (const def of contribution.params) params[def.id] = { value: structuredClone(def.default) }
  return params
}

/** Time tolerance for "is there a keyframe here": half a frame at 240fps. */
export const KF_EPSILON: Flicks = 705_600_000 / 480

export function keyframeAt(pv: ParamValue | undefined, t: Flicks): Keyframe | undefined {
  return pv?.keyframes?.find((k) => Math.abs(k.t - t) <= KF_EPSILON)
}

export function isAnimated(pv: ParamValue | undefined) {
  return !!pv?.keyframes && pv.keyframes.length > 0
}

/** All keyframe times of a clip (for timeline ticks), sorted and de-duplicated. */
export function clipKeyframeTimes(clip: Clip): Flicks[] {
  const set = new Set<Flicks>()
  for (const p of clip.properties) {
    if (!p.enabled) continue
    for (const pv of Object.values(p.params)) for (const k of pv.keyframes ?? []) set.add(k.t)
  }
  return [...set].sort((a, b) => a - b)
}

// ───────────────────── easing math (used by built-in easings & UI) ─────────────────────

/** CSS-style cubic-bezier(x1,y1,x2,y2) solver. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const solve = (x: number) => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x
      if (Math.abs(err) < 1e-6) return t
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0
    let hi = 1
    t = x
    while (lo < hi) {
      const v = sx(t)
      if (Math.abs(v - x) < 1e-6) return t
      if (x > v) lo = t
      else hi = t
      t = (lo + hi) / 2
      if (hi - lo < 1e-7) break
    }
    return t
  }
  return (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : sy(solve(p)))
}

/** Damped spring settling over the segment. */
export function spring(stiffness: number, damping: number, mass = 1): (p: number) => number {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  // map p to a time window where the spring has settled (~ 99.9%)
  const T = zeta < 1 ? 6.9 / (zeta * w0 || 1) : 6.9 / (w0 * (zeta - Math.sqrt(Math.max(0, zeta * zeta - 1))) || 1)
  const dur = Math.min(10, Math.max(0.2, T))
  return (p: number) => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    const t = p * dur
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  }
}
