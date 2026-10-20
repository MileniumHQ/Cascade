import { createMemo, createSignal, For, Index, onCleanup, Show, createEffect } from 'solid-js'
import type { EasingContribution } from '@core/plugin-api'
import type { EasingRef } from '@shared/project'
import { FLICKS, flicksToFrame } from '@shared/time'
import { Button, NumberField } from '@ui/kit'
import { useRegistry, useValue } from '@ui/reactive'
import { easingOf, miniCurve } from './curves'
import { curvePath, easingParams, easingValue, fitBezier, plotRange, resolveRefs, sameEasing, sampleEasing } from './model'
import type { PanelState } from './context'

// Big plot geometry (SVG user units; the element scales uniformly).
const VW = 256
const VH = 168
const L = 28
const R = 242
const T = 12
const B = 150

const BEZIER = 'cubic-bezier'
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const r2 = (v: number) => Math.round(v * 100) / 100

export const defaultRef = (e: EasingContribution): EasingRef => ({ id: e.id, params: e.params?.map((p) => p.default) })

/** Sidebar: curve preview with draggable bezier handles, parameters and the preset grid. */
export function EasingEditor(props: { s: PanelState }) {
  const { app, ui } = props.s
  const regs = app.registries
  const kfSel = useValue(app.selection.keyframes)
  const easings = useRegistry(regs.easings)

  const items = createMemo(() => resolveRefs(props.s.project(), props.s.project().activeTimeline, kfSel()))
  const primary = () => items()[items().length - 1]
  const ref = () => primary()?.kf.easing
  const def = () => easingOf(regs, ref())
  const uniform = createMemo(() => items().every((i) => sameEasing(i.kf.easing, primary()!.kf.easing)))
  const params = () => easingParams(def(), ref())
  const isBezier = () => uniform() && def()?.id === BEZIER
  const sel = () => items().map((i) => i.ref)

  const apply = (next: EasingRef, gesture?: 'start' | 'update' | 'end') => {
    if (!sel().length) return
    app.edit.setKeyframeEasing(sel(), next, gesture ? { gesture } : undefined)
  }

  const groups = createMemo(() => {
    const out = new Map<string, EasingContribution[]>()
    for (const e of easings()) {
      const g = e.group ?? 'Other'
      if (!out.has(g)) out.set(g, [])
      out.get(g)!.push(e)
    }
    return [...out.entries()]
  })

  // ───────────── plot ─────────────
  const [frozen, setFrozen] = createSignal<[number, number] | null>(null)
  const samples = createMemo(() => sampleEasing(def(), ref(), 160))
  const domain = createMemo<[number, number]>(() => {
    if (frozen()) return frozen()!
    const p = params()
    return plotRange(samples(), 0.14, isBezier() ? [p[1], p[3]] : [])
  })
  const px = (p: number) => L + p * (R - L)
  const py = (y: number) => B - ((y - domain()[0]) / (domain()[1] - domain()[0])) * (B - T)
  const path = createMemo(() => curvePath(samples(), R - L, B - T, domain(), L, T))
  const areaPath = () => `${path()}L${R} ${py(0)}L${L} ${py(0)}Z`
  /** Real extent of the curve + handles (without the plot padding) — decides what counts as overshoot. */
  const extent = createMemo(() => plotRange(samples(), 0, isBezier() ? [params()[1], params()[3]] : []))
  const overHigh = () => extent()[1] > 1.004
  const overLow = () => extent()[0] < -0.004

  let plot!: SVGSVGElement
  const dragHandle = (e: PointerEvent, i: 0 | 1) => {
    e.preventDefault()
    e.stopPropagation()
    setFrozen(domain())
    let started = false
    let last = params()
    const move = (ev: PointerEvent) => {
      const rect = plot.getBoundingClientRect()
      const vx = ((ev.clientX - rect.left) / rect.width) * VW
      const vy = ((ev.clientY - rect.top) / rect.height) * VH
      const p = (vx - L) / (R - L)
      const [lo, hi] = frozen()!
      const y = lo + ((B - vy) / (B - T)) * (hi - lo)
      const next = [...last]
      next[i * 2] = clamp(r2(p), 0, 1)
      next[i * 2 + 1] = clamp(r2(y), -1, 2)
      last = next
      apply({ id: BEZIER, params: next }, started ? 'update' : 'start')
      started = true
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (started) apply({ id: BEZIER, params: last }, 'end')
      setFrozen(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Animated preview: a dot rides the curve; a second one slides along the value rail.
  let dot!: SVGCircleElement
  let railDot!: SVGCircleElement
  let trace!: SVGLineElement
  let dropLine!: SVGLineElement
  createEffect(() => {
    if (!props.s.visible() || !primary()) return
    let raf = 0
    const cycle = 2400
    const tick = (now: number) => {
      const ph = (now % cycle) / cycle
      const p = clamp(ph / 0.62, 0, 1)
      const y = easingValue(def(), ref(), p)
      const cx = px(p)
      const cy = py(y)
      dot.setAttribute('cx', String(cx))
      dot.setAttribute('cy', String(cy))
      railDot.setAttribute('cy', String(cy))
      trace.setAttribute('x2', String(cx))
      trace.setAttribute('y1', String(cy))
      trace.setAttribute('y2', String(cy))
      dropLine.setAttribute('x1', String(cx))
      dropLine.setAttribute('x2', String(cx))
      dropLine.setAttribute('y1', String(cy))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  // ───────────── info ─────────────
  const paramLabel = () => {
    const p = primary()
    if (!p) return ''
    const d = regs.properties.get(p.inst.type)?.params.find((x) => x.id === p.ref.paramId)
    const prop = regs.properties.get(p.inst.type)
    return `${prop?.name ?? p.inst.type} · ${d?.label ?? p.ref.paramId}`
  }
  const segment = () => {
    const p = primary()
    if (!p?.next) return null
    const dt = p.next.t - p.kf.t
    return `${(dt / FLICKS).toFixed(2)}s · ${flicksToFrame(dt, app.fps())}f`
  }
  const fit = createMemo(() => {
    const e = def()
    if (!e || e.id === BEZIER || e.id === 'hold' || e.id === 'steps' || e.id === 'linear') return null
    const r = ref()
    const f = fitBezier((p) => easingValue(e, r, p))
    return f.err < 0.025 ? f : null
  })

  const setParam = (i: number, v: number, phase: 'start' | 'update' | 'end') => {
    const e = def()
    if (!e) return
    const next = [...params()]
    next[i] = v
    apply({ id: e.id, params: next }, phase)
  }

  return (
    <aside class="kf-side">
      <Show
        when={primary()}
        fallback={
          <div class="kf-side-empty">
            <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden="true">
              <path d="M6 56 C 34 56, 40 8, 90 8" />
              <circle cx="6" cy="56" r="3.5" />
              <circle cx="90" cy="8" r="3.5" />
            </svg>
            <div class="kf-side-empty-title">Easing</div>
            <div class="kf-side-empty-hint">Select one or more keyframes to shape the motion that follows them.</div>
          </div>
        }
      >
        <div class="kf-side-top">
        <header class="kf-side-head">
          <div class="kf-side-title">
            <span class="kf-side-ename">{uniform() ? (def()?.name ?? ref()?.id) : 'Mixed easings'}</span>
            <Show when={items().length > 1}>
              <span class="kf-chip">{items().length} keyframes</span>
            </Show>
          </div>
          <div class="kf-side-sub">
            {paramLabel()}
            <Show when={segment()}>
              <span class="kf-side-seg tnum">{segment()}</span>
            </Show>
          </div>
        </header>

        <div class="kf-plotwrap">
          <svg ref={plot} class="kf-plot" viewBox={`0 0 ${VW} ${VH}`}>
            <defs>
              <linearGradient id="kf-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--lime)" stop-opacity="0.18" />
                <stop offset="1" stop-color="var(--lime)" stop-opacity="0" />
              </linearGradient>
              <pattern id="kf-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(130,203,255,0.16)" stroke-width="2" />
              </pattern>
              <clipPath id="kf-plot-clip">
                <rect x={L} y={T} width={R - L} height={B - T} rx="3" />
              </clipPath>
            </defs>
            <rect class="kf-plot-bg" x={L} y={T} width={R - L} height={B - T} rx="3" />
            {/* overshoot zones above 1 and below 0 */}
            <Show when={overHigh()}>
              <rect class="kf-plot-over" x={L} y={T} width={R - L} height={Math.max(0, py(1) - T)} fill="url(#kf-hatch)" />
            </Show>
            <Show when={overLow()}>
              <rect class="kf-plot-over" x={L} y={py(0)} width={R - L} height={Math.max(0, B - py(0))} fill="url(#kf-hatch)" />
            </Show>
            <For each={[0.25, 0.5, 0.75]}>{(g) => <line class="kf-plot-grid" x1={px(g)} x2={px(g)} y1={T} y2={B} />}</For>
            <For each={[0.5]}>{(g) => <line class="kf-plot-grid" x1={L} x2={R} y1={py(g)} y2={py(g)} />}</For>
            <line class="kf-plot-ref" x1={L} x2={R} y1={py(0)} y2={py(0)} />
            <line class="kf-plot-ref" x1={L} x2={R} y1={py(1)} y2={py(1)} />
            <text class="kf-plot-lbl" x={L - 6} y={py(0) + 3.5} text-anchor="end">0</text>
            <text class="kf-plot-lbl" x={L - 6} y={py(1) + 3.5} text-anchor="end">1</text>
            <Show when={overHigh() || overLow()}>
              <text class="kf-plot-lbl dim" x={L + 6} y={overHigh() ? T + 11 : B - 6}>overshoot</text>
            </Show>
            <g clip-path="url(#kf-plot-clip)">
              <path d={areaPath()} fill="url(#kf-area)" />
              <line ref={trace} class="kf-trace" x1={L} x2={L} y1={B} y2={B} />
              <line ref={dropLine} class="kf-trace" x1={L} x2={L} y1={B} y2={B} />
            </g>
            <Show when={isBezier()}>
              <line class="kf-hline" x1={px(0)} y1={py(0)} x2={px(params()[0])} y2={py(params()[1])} />
              <line class="kf-hline" x1={px(1)} y1={py(1)} x2={px(params()[2])} y2={py(params()[3])} />
            </Show>
            <path class="kf-curve" d={path()} />
            <circle class="kf-end" cx={px(0)} cy={py(0)} r="3.2" />
            <circle class="kf-end" cx={px(1)} cy={py(1)} r="3.2" />
            <circle ref={railDot} class="kf-rail-dot" cx={L - 12} cy={B} r="3.2" />
            <circle ref={dot} class="kf-ride" cx={L} cy={B} r="4.4" />
            <Show when={isBezier()}>
              <For each={[0, 1] as const}>
                {(i) => (
                  <g class="kf-handle" onPointerDown={(e) => dragHandle(e, i)}>
                    <circle class="kf-handle-hit" cx={px(params()[i * 2])} cy={py(params()[i * 2 + 1])} r="13" />
                    <circle class="kf-handle-dot" cx={px(params()[i * 2])} cy={py(params()[i * 2 + 1])} r="5.6" />
                  </g>
                )}
              </For>
            </Show>
          </svg>
        </div>

        <Show when={!uniform()}>
          <div class="kf-note">The selected keyframes use different easings. Pick a preset to give them all the same one.</div>
        </Show>
        <Show when={uniform() && !primary()?.next}>
          <div class="kf-note">Last keyframe of its parameter — this easing applies once another keyframe follows it.</div>
        </Show>

        <Show when={uniform() && (def()?.params?.length ?? 0) > 0}>
          <div class="kf-params">
            <Index each={def()!.params!}>
              {(p, i) => (
                <label class="kf-param-field">
                  <span>{p().label}</span>
                  <NumberField
                    value={params()[i]}
                    step={p().step ?? 0.01}
                    min={p().min}
                    max={p().max}
                    precision={(p().step ?? 0.01) < 1 ? 2 : 0}
                    onChange={(v, phase) => setParam(i, v, phase)}
                  />
                </label>
              )}
            </Index>
          </div>
        </Show>
        <Show when={uniform() && fit()}>
          {(f) => (
            <div class="kf-customize">
              <Button size="sm" icon="spline" onClick={() => apply({ id: BEZIER, params: [...f().params] })}>
                Edit as custom curve
              </Button>
            </div>
          )}
        </Show>

        </div>

        <div class="kf-presets">
          <For each={groups()}>
            {([group, list]) => (
              <section>
                <h4>{group}</h4>
                <div class="kf-preset-grid">
                  <For each={list}>
                    {(e) => (
                      <button
                        class={`kf-preset ${uniform() && ref()?.id === e.id ? 'on' : ''}`}
                        onClick={() => apply(defaultRef(e))}
                        data-tip={e.name}
                      >
                        <MiniCurve app={app} refr={defaultRef(e)} />
                        <span>{e.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </Show>
    </aside>
  )
}

/** Small curve thumbnail used by preset cells and menus. */
export function MiniCurve(p: { app: PanelState['app']; refr: EasingRef; class?: string }) {
  const cv = createMemo(() => miniCurve(p.app.registries, p.refr, 44))
  const lo = () => cv().lo
  const hi = () => cv().hi
  // baseline (0) and top (1) guides inside the thumbnail
  const y0 = () => 100 - ((0 - lo()) / (hi() - lo())) * 100
  const y1 = () => 100 - ((1 - lo()) / (hi() - lo())) * 100
  return (
    <svg class={`kf-mini ${p.class ?? ''}`} viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="0" x2="100" y1={y0()} y2={y0()} vector-effect="non-scaling-stroke" />
      <line x1="0" x2="100" y1={y1()} y2={y1()} vector-effect="non-scaling-stroke" />
      <path d={cv().d} vector-effect="non-scaling-stroke" />
    </svg>
  )
}
