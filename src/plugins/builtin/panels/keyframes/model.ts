/**
 * Pure model for the Keyframes panel: row layout, grouping, snapping, easing sampling and
 * value display. No DOM, no Solid — so it can be unit-tested.
 */
import type { CascadeAPI } from '@core/app'
import type { ParamDef, ParamTypeContribution, PropertyContribution } from '@core/plugin-api'
import { cubicBezier, evaluateParam, KF_EPSILON } from '@core/evaluate'
import type { Clip, EasingRef, Id, Keyframe, ParamValue, Project, PropertyInstance } from '@shared/project'
import { parseColor, toHex } from '@shared/color'
import { snapToFrame, type Flicks, type FrameRate } from '@shared/time'
import { FLICKS } from '@shared/time'

export const ROW_H = 28
export const SNAP_PX = 6

export type KfRef = { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }
export type Glyph = 'diamond' | 'circle' | 'square' | 'hourglass' | 'triangle'

/** Which params of a property are listed: only animated ones, everything, or just the header. */
export type Expansion = 'collapsed' | 'animated' | 'all'

export interface KfItem {
  id: Id
  /** Clip-relative time. */
  t: Flicks
  glyph: Glyph
  easingId: string
  /** The ref(s) a click on this glyph selects (one for param rows, many for summary rows). */
  refs: KfRef[]
}

export interface SegItem {
  /** Clip-relative start/end. */
  a: Flicks
  b: Flicks
  hold: boolean
  easing: EasingRef | undefined
  /** Values at both ends are equal: nothing actually moves in this span. */
  flat: boolean
  /** Keyframe ids this bar belongs to (start keyframe), for selection tint. */
  startRefs: KfRef[]
}

interface RowBase {
  key: string
  y: number
  kfs: KfItem[]
  segs: SegItem[]
}
export interface ClipRow extends RowBase {
  kind: 'clip'
  clip: Clip
}
export interface PropRow extends RowBase {
  kind: 'prop'
  inst: PropertyInstance
  contrib: PropertyContribution | undefined
  expansion: Expansion
  animatedCount: number
  paramCount: number
}
export interface ParamRow extends RowBase {
  kind: 'param'
  inst: PropertyInstance
  def: ParamDef
  type: ParamTypeContribution | undefined
  pv: ParamValue | undefined
  animated: boolean
}
/** "Show all (n)" / "Show animated only" toggle line under a property. */
export interface MoreRow extends RowBase {
  kind: 'more'
  inst: PropertyInstance
  count: number
  open: boolean
}
export type Row = ClipRow | PropRow | ParamRow | MoreRow

type Regs = CascadeAPI['registries']

export const paramKeyframes = (pv: ParamValue | undefined): Keyframe[] => pv?.keyframes ?? []

export const defaultExpansion = (animatedCount: number, focused: boolean): Expansion =>
  animatedCount > 0 ? 'animated' : focused ? 'all' : 'collapsed'

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

const glyphOf = (regs: Regs, e: EasingRef | undefined): Glyph => regs.easings.get(e?.id ?? 'linear')?.glyph ?? 'diamond'

/** Keyframes with (almost) the same time collapse into one summary glyph. */
export function groupByTime(items: KfItem[]): KfItem[] {
  const sorted = [...items].sort((a, b) => a.t - b.t)
  const out: KfItem[] = []
  for (const it of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.t - it.t) <= KF_EPSILON) {
      last.refs.push(...it.refs)
      if (last.glyph !== it.glyph) last.glyph = 'diamond'
    } else out.push({ ...it, refs: [...it.refs], id: `g${it.t}` })
  }
  return out
}

function summarySegs(kfs: KfItem[]): SegItem[] {
  const segs: SegItem[] = []
  for (let i = 0; i + 1 < kfs.length; i++) segs.push({ a: kfs[i].t, b: kfs[i + 1].t, hold: false, easing: undefined, flat: false, startRefs: kfs[i].refs })
  return segs
}

export interface BuildOptions {
  expansion: (inst: PropertyInstance, animatedCount: number) => Expansion
  showAll: boolean
}

/** Flat list of dope-sheet rows for a clip, with y positions. */
export function buildRows(clip: Clip, regs: Regs, opts: BuildOptions): Row[] {
  const rows: Row[] = []
  const push = <R extends Row>(r: Omit<R, 'y'>) => rows.push({ ...r, y: rows.length * ROW_H } as R)
  const clipItems: KfItem[] = []
  const propRows: { idx: number; items: KfItem[] }[] = []

  // Reserve the clip row; it's filled in after the properties are known.
  push<ClipRow>({ kind: 'clip', key: 'clip', clip, kfs: [], segs: [] })

  for (const inst of clip.properties) {
    const contrib = regs.properties.get(inst.type)
    const defs = (contrib?.params ?? []).filter((d) => !d.hidden && d.animatable !== false)
    const animated = defs.filter((d) => (inst.params[d.id]?.keyframes?.length ?? 0) > 0)
    const rest = defs.filter((d) => !animated.includes(d))
    const expansion = opts.showAll ? 'all' : opts.expansion(inst, animated.length)
    const propIdx = rows.length
    push<PropRow>({ kind: 'prop', key: `p:${inst.id}`, inst, contrib, expansion, animatedCount: animated.length, paramCount: defs.length, kfs: [], segs: [] })
    const propItems: KfItem[] = []

    const shown = expansion === 'all' ? [...animated, ...rest] : expansion === 'animated' ? animated : []
    // Animated params contribute to the summaries even when their rows are hidden.
    for (const def of animated) {
      const pv = inst.params[def.id]
      const kfs = paramKeyframes(pv)
      const items: KfItem[] = kfs.map((k) => ({
        id: k.id,
        t: k.t,
        glyph: glyphOf(regs, k.easing),
        easingId: k.easing?.id ?? 'linear',
        refs: [{ clipId: clip.id, propertyId: inst.id, paramId: def.id, keyframeId: k.id }]
      }))
      propItems.push(...items.map((i) => ({ ...i, refs: [...i.refs] })))
      clipItems.push(...items.map((i) => ({ ...i, refs: [...i.refs] })))
      if (!shown.includes(def)) continue
      const segs: SegItem[] = []
      for (let i = 0; i + 1 < kfs.length; i++) {
        const a = kfs[i]
        const b = kfs[i + 1]
        segs.push({
          a: a.t,
          b: b.t,
          hold: a.easing?.id === 'hold',
          easing: a.easing,
          flat: sameValue(a.value, b.value),
          startRefs: items[i].refs
        })
      }
      push<ParamRow>({ kind: 'param', key: `r:${inst.id}:${def.id}`, inst, def, type: regs.paramTypes.get(def.type), pv, animated: true, kfs: items, segs })
    }
    if (expansion === 'all') {
      for (const def of rest) {
        push<ParamRow>({ kind: 'param', key: `r:${inst.id}:${def.id}`, inst, def, type: regs.paramTypes.get(def.type), pv: inst.params[def.id], animated: false, kfs: [], segs: [] })
      }
    }
    if (!opts.showAll && rest.length > 0 && expansion !== 'collapsed') {
      push<MoreRow>({ kind: 'more', key: `m:${inst.id}`, inst, count: rest.length, open: expansion === 'all', kfs: [], segs: [] })
    }
    propRows.push({ idx: propIdx, items: propItems })
  }

  for (const { idx, items } of propRows) {
    const g = groupByTime(items)
    const row = rows[idx]
    row.kfs = g
    row.segs = summarySegs(g)
  }
  const cg = groupByTime(clipItems)
  rows[0].kfs = cg
  rows[0].segs = summarySegs(cg)
  return rows
}

// ───────────────────────────── snapping ─────────────────────────────

export interface SnapInput {
  /** Raw time (timeline time) the dragged keyframe wants to be at. */
  t: Flicks
  fps: FrameRate
  pxPerSecond: number
  /** Timeline times to snap to (playhead, other keyframes, clip edges). */
  targets: Flicks[]
  /** Alt held: no snapping at all. */
  free: boolean
}

/** Snap to nearby targets (within SNAP_PX) first, otherwise to the frame grid. */
export function snapTime({ t, fps, pxPerSecond, targets, free }: SnapInput): { t: Flicks; target: Flicks | null } {
  if (free) return { t: Math.round(t), target: null }
  const tol = (SNAP_PX / pxPerSecond) * FLICKS
  let best: Flicks | null = null
  for (const c of targets) if (Math.abs(c - t) <= tol && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c
  if (best !== null) return { t: best, target: best }
  return { t: snapToFrame(t, fps), target: null }
}

// ───────────────────────────── easings ─────────────────────────────

export interface EasingLike {
  id: string
  name?: string
  params?: { label: string; default: number; min?: number; max?: number; step?: number }[]
  fn(p: number, params: number[]): number
}

export const easingParams = (e: EasingLike | undefined, ref: EasingRef | undefined): number[] => {
  const defs = e?.params ?? []
  return defs.map((d, i) => ref?.params?.[i] ?? d.default)
}

export const sameEasing = (a: EasingRef | undefined, b: EasingRef | undefined) =>
  (a?.id ?? 'linear') === (b?.id ?? 'linear') && JSON.stringify(a?.params ?? []) === JSON.stringify(b?.params ?? [])

/** Evaluate an easing for display: hold is drawn as a step at the end of the span. */
export function easingValue(e: EasingLike | undefined, ref: EasingRef | undefined, p: number): number {
  if (!e) return p
  if (e.id === 'hold') return p >= 1 ? 1 : 0
  return e.fn(Math.min(1, Math.max(0, p)), easingParams(e, ref))
}

export function sampleEasing(e: EasingLike | undefined, ref: EasingRef | undefined, n = 96): { p: number; y: number }[] {
  const out: { p: number; y: number }[] = []
  for (let i = 0; i <= n; i++) {
    const p = i / n
    out.push({ p, y: easingValue(e, ref, p) })
  }
  return out
}

/** Vertical plot range for a sampled curve: always includes 0..1, plus any overshoot. */
export function plotRange(samples: { y: number }[], pad = 0.12, extra: number[] = []): [number, number] {
  let lo = 0
  let hi = 1
  for (const s of samples) {
    if (s.y < lo) lo = s.y
    if (s.y > hi) hi = s.y
  }
  for (const y of extra) {
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  const span = hi - lo
  return [lo - span * pad, hi + span * pad]
}

/** SVG path for samples, mapped into a w×h box (y flipped). */
export function curvePath(samples: { p: number; y: number }[], w: number, h: number, [lo, hi]: [number, number], ox = 0, oy = 0): string {
  const sx = (p: number) => ox + p * w
  const sy = (y: number) => oy + h - ((y - lo) / (hi - lo)) * h
  let d = ''
  for (let i = 0; i < samples.length; i++) d += `${i ? 'L' : 'M'}${sx(samples[i].p).toFixed(2)} ${sy(samples[i].y).toFixed(2)}`
  return d
}

// ───────────────────────────── value display ─────────────────────────────

const r = (v: number, d = 1) => String(+v.toFixed(d))

/** Short, unit-aware value text for the readouts (px at the reference resolution, %, …). */
export function displayValue(def: ParamDef, type: ParamTypeContribution | undefined, v: unknown, project: Pick<Project, 'settings'>): string {
  const { width: W, height: H } = project.settings
  const unit = def.unit
  if (typeof v === 'number') {
    if (unit === 'frameX') return `${r(v * W)}px`
    if (unit === 'frameY' || unit === 'frameLen') return `${r(v * H)}px`
    if (unit === 'percent') return `${r(v * 100)}%`
  }
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    if (unit === 'frameXY') return `${r(v[0] * W, 0)}, ${r(v[1] * H, 0)}`
    if (unit === 'percent') return `${r(v[0] * 100, 0)}%, ${r(v[1] * 100, 0)}%`
  }
  if (def.type === 'color' && typeof v === 'string') return toHex(parseColor(v))
  try {
    return type?.format ? type.format(v, def) : String(v)
  } catch {
    return String(v)
  }
}

/** Evaluated value of one param at a clip-local time. */
export function valueAt(app: CascadeAPI, def: ParamDef, pv: ParamValue | undefined, local: Flicks): unknown {
  return evaluateParam(app.registries, def, pv, local)
}

/** Resolve selected refs against the project (drops anything that no longer exists). */
export function resolveRefs(project: Project, tlId: Id, refs: KfRef[]) {
  const tl = project.timelines[tlId]
  const out: { ref: KfRef; clip: Clip; inst: PropertyInstance; kf: Keyframe; next: Keyframe | undefined }[] = []
  if (!tl) return out
  for (const ref of refs) {
    let clip: Clip | undefined
    for (const tr of tl.tracks) {
      clip = tr.clips.find((c) => c.id === ref.clipId)
      if (clip) break
    }
    const inst = clip?.properties.find((p) => p.id === ref.propertyId)
    const kfs = inst?.params[ref.paramId]?.keyframes
    const i = kfs?.findIndex((k) => k.id === ref.keyframeId) ?? -1
    if (clip && inst && kfs && i >= 0) out.push({ ref, clip, inst, kf: kfs[i], next: kfs[i + 1] })
  }
  return out
}

export const refKey = (r: KfRef) => `${r.propertyId}/${r.paramId}/${r.keyframeId}`

// ───────────────────────────── bezier fitting ─────────────────────────────

/**
 * Best-fit cubic-bezier (x1, y1, x2, y2) for an arbitrary easing — lets a preset be turned into
 * an editable custom curve. Coordinate descent on RMS error; `err` tells how faithful it is.
 */
export function fitBezier(target: (p: number) => number, samples = 32): { params: [number, number, number, number]; err: number } {
  const ps = Array.from({ length: samples + 1 }, (_, i) => i / samples)
  const want = ps.map(target)
  const lim: [number, number][] = [[0, 1], [-1, 2], [0, 1], [-1, 2]]
  const cost = (c: number[]) => {
    const f = cubicBezier(c[0], c[1], c[2], c[3])
    let e = 0
    for (let i = 0; i < ps.length; i++) e += (f(ps[i]) - want[i]) ** 2
    return Math.sqrt(e / ps.length)
  }
  let best = [0.42, 0, 0.58, 1]
  let bestErr = cost(best)
  for (const start of [[0.25, 0.1, 0.25, 1], [0.1, 0.8, 0.3, 1], [0.7, 0, 0.9, 0.2]]) {
    const e = cost(start)
    if (e < bestErr) (best = start), (bestErr = e)
  }
  let step = 0.25
  for (let iter = 0; iter < 60 && step > 0.001; iter++) {
    let improved = false
    for (let i = 0; i < 4; i++)
      for (const dir of [-1, 1]) {
        const c = [...best]
        c[i] = Math.min(lim[i][1], Math.max(lim[i][0], c[i] + dir * step))
        const e = cost(c)
        if (e < bestErr - 1e-9) (best = c), (bestErr = e), (improved = true)
      }
    if (!improved) step /= 2
  }
  return { params: best.map((v) => Math.round(v * 100) / 100) as [number, number, number, number], err: bestErr }
}
