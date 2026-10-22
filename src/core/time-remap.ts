import type { Clip, Keyframe, ParamValue, Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'
import { easeProgress, type EvalRegistries } from './evaluate'
import type { PropertyContribution } from './plugin-api'
import type { Registry } from './registry'

/** Zero speed holds a frame; inverse queries outside a hold return infinity. */
export const MIN_SPEED = 0
export const MAX_SPEED = 100

/**
 * Timeline → source time mapping for a clip. Speed may vary over clip-local time (a keyframed
 * time-remap property); the source position is its integral.
 */
export interface TimeMap {
  /** Speed if it never changes, else null. Nonnegative; see `reversed`. */
  readonly constant: number | null
  /** The source plays backwards: `offset` decreases from 0 (sourceIn is the source time at clip start). */
  readonly reversed?: boolean
  /** Slowest and fastest keyframed speed (equal when constant). */
  readonly min: number
  readonly max: number
  /** Speed at clip-local time. */
  speedAt(local: Flicks): number
  /** Source flicks advanced since `sourceIn` at clip-local time (∫ speed; negative when reversed). */
  offset(local: Flicks): Flicks
  /** Inverse of `offset`: clip-local time at which the source has advanced `offset` flicks. */
  localAt(offset: Flicks): Flicks
}

export interface RemapRegistries extends EvalRegistries {
  properties: Registry<PropertyContribution>
}

const clampSpeed = (v: number) => (Number.isFinite(v) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)) : 1)

export function constantMap(speed: number): TimeMap {
  const s = clampSpeed(speed)
  return { constant: s, min: s, max: s, speedAt: () => s, offset: (t) => t * s, localAt: (o) => s ? o / s : o === 0 ? 0 : Math.sign(o) * Infinity }
}

/**
 * Map for a numeric speed curve given as keyframes (clip-local t) times a constant base.
 * Integrates each segment with Simpson's rule; exact for constant stretches and linear ramps.
 */
export function curveMap(base: number, kfs: Keyframe[], regs: EvalRegistries): TimeMap {
  if (kfs.length === 0) return constantMap(base)
  if (kfs.length === 1) return constantMap(base * Number(kfs[0].value))
  const v = (k: Keyframe) => Number(k.value)
  const speedIn = (i: number, t: Flicks) => {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (a.easing?.id === 'hold') return clampSpeed(base * v(a))
    const p = easeProgress(regs, a, (t - a.t) / (b.t - a.t))
    return clampSpeed(base * (v(a) + (v(b) - v(a)) * p))
  }
  // ∫ speed over [a.t, t] inside segment i.
  const partial = (i: number, t: Flicks, n: number) => {
    const a = kfs[i].t
    const h = (t - a) / n
    if (h <= 0) return 0
    let sum = speedIn(i, a) + speedIn(i, t)
    for (let k = 1; k < n; k++) sum += (k % 2 ? 4 : 2) * speedIn(i, a + k * h)
    return (sum * h) / 3
  }
  const first = clampSpeed(base * v(kfs[0]))
  const last = clampSpeed(base * v(kfs[kfs.length - 1]))
  // Cumulative offset at each keyframe.
  const cum = [first * kfs[0].t]
  for (let i = 0; i < kfs.length - 1; i++) cum.push(cum[i] + partial(i, kfs[i + 1].t, 64))
  const seg = (t: Flicks) => {
    let lo = 0
    let hi = kfs.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (kfs[mid].t <= t) lo = mid
      else hi = mid
    }
    return lo
  }
  const speedAt = (t: Flicks) => (t <= kfs[0].t ? first : t >= kfs[kfs.length - 1].t ? last : speedIn(seg(t), t))
  const rawOffset = (t: Flicks) => {
    if (t <= kfs[0].t) return first * t
    const n = kfs.length - 1
    if (t >= kfs[n].t) return cum[n] + last * (t - kfs[n].t)
    const i = seg(t)
    return cum[i] + partial(i, t, 16)
  }
  // Trims keep keyframes outside the clip (including negative times). Rebase the
  // primitive at local zero so sourceIn always denotes the actual first source frame.
  const origin = rawOffset(0)
  const offset = (t: Flicks) => rawOffset(t) - origin
  const localAt = (o: Flicks) => {
    if (o === 0) return 0
    const target = o + origin
    if (target <= cum[0]) return first ? target / first : target === cum[0] ? Math.min(0, kfs[0].t) : -Infinity
    const n = kfs.length - 1
    if (target > cum[n]) return last ? kfs[n].t + (target - cum[n]) / last : Infinity
    let i = 0
    while (i < n - 1 && cum[i + 1] < target) i++
    // Generalized inverse: bisect nondecreasing segments, including zero-speed plateaus.
    let lo = kfs[i].t
    let hi = kfs[i + 1].t
    for (let k = 0; k < 40 && hi - lo > 1; k++) {
      const mid = (lo + hi) / 2
      if (offset(mid) < o) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  const speeds = kfs.map((k) => clampSpeed(base * v(k)))
  return { constant: null, min: Math.min(...speeds), max: Math.max(...speeds), speedAt, offset, localAt }
}

/** The same mapping played backwards: the source runs from `sourceIn` down. */
export function reverseMap(m: TimeMap): TimeMap {
  if (m.reversed) return m
  return { ...m, reversed: true, offset: (t) => -m.offset(t), localAt: (o) => m.localAt(-o) }
}

/** Source range [lo, hi) a clip uses, in source flicks, whichever way it plays. */
export function sourceSpan(clip: Clip, map: TimeMap): { lo: Flicks; hi: Flicks } {
  const a = clip.sourceIn
  const b = clip.sourceIn + map.offset(clip.duration)
  return { lo: Math.min(a, b), hi: Math.max(a, b) }
}

/** The time-remap property instance and param driving a clip's speed, if any. */
function remapParam(clip: Clip, regs: RemapRegistries): { pv: ParamValue; reversed: boolean } | null {
  for (const p of clip.properties) {
    if (!p.enabled) continue
    const contrib = regs.properties.get(p.type)
    const param = contrib?.timeRemap
    if (!param) continue
    const rev = contrib.timeReverse
    const reversed = !!rev && !!(p.params[rev]?.value ?? contrib.params.find((d) => d.id === rev)?.default)
    return { pv: p.params[param] ?? { value: contrib.params.find((d) => d.id === param)?.default ?? 1 }, reversed }
  }
  return null
}

const cache = new WeakMap<Clip, { partner: Clip | null; map: TimeMap }>()

/**
 * Time map of a clip: `clip.speed` × its time-remap property. Linked clips without their own
 * time-remap (the audio of a video) follow their partner's, so picture and sound stay together.
 */
export function clipTimeMap(clip: Clip, timeline: Timeline | undefined, regs: RemapRegistries): TimeMap {
  let found = remapParam(clip, regs)
  let partner: Clip | null = null
  if (!found && clip.linkId && timeline) {
    for (const tr of timeline.tracks)
      for (const c of tr.clips)
        if (!partner && c !== clip && c.linkId === clip.linkId && remapParam(c, regs)) {
          partner = c
          found = remapParam(c, regs)
        }
  }
  // Committed document objects are frozen (immutable), so they can be cached; drafts cannot.
  const cacheable = Object.isFrozen(clip)
  const hit = cacheable ? cache.get(clip) : undefined
  if (hit && hit.partner === partner) return hit.map
  const base = clip.speed ?? 1
  // A partner's keyframes are in its own clip-local time.
  const shift = partner ? partner.start - clip.start : 0
  const pv = found?.pv
  const kfs = pv?.keyframes?.length ? (shift ? pv.keyframes.map((k) => ({ ...k, t: k.t + shift })) : pv.keyframes) : null
  const forward = !pv ? constantMap(base) : kfs ? curveMap(base, kfs, regs) : constantMap(base * Number(pv.value ?? 1))
  const map = found?.reversed ? reverseMap(forward) : forward
  if (cacheable) cache.set(clip, { partner, map })
  return map
}
