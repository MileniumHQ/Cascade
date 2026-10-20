import { createMemo, createSignal, For, Show, type Accessor } from 'solid-js'
import { evaluateParam } from '@core/evaluate'
import type { ParamDef, ParamTypeContribution } from '@core/plugin-api'
import type { Clip, PropertyInstance } from '@shared/project'
import { FLICKS, formatTimecode } from '@shared/time'
import { useValue } from '@ui/reactive'
import { Glyph } from './Glyph'
import type { PanelState } from './context'
import type { DragPrep } from './DopeSheet'
import { refKey, type Glyph as GlyphKind, type KfItem, type KfRef, type ParamRow, type Row } from './model'
import { easingOf } from './curves'

const PALETTE = ['#82cbff', '#ff8fa3', '#f2c14e', '#ad9cf2', '#52c48e', '#ff9d5c', '#7fe0e0', '#e8a0f2']
const AXIS = ['X', 'Y', 'Z', 'W']

export interface GraphApi {
  s: PanelState
  clip: Accessor<Clip | null>
  scrollX: Accessor<number>
  pps: Accessor<number>
  laneW: Accessor<number>
  /** Height available to the graph (below the ruler). */
  height: Accessor<number>
  selKeys: Accessor<Set<string>>
  prepareDrag(e: PointerEvent, item: KfItem, row: Row): DragPrep | null
  timeDrag(d: DragPrep): { move(ev: PointerEvent): void; end(): void }
}

interface Chan {
  key: string
  inst: PropertyInstance
  def: ParamDef
  type: ParamTypeContribution
  ch: number
  multi: boolean
  color: string
  scale: number
  unit: string
}

const niceStep = (raw: number) => {
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}
const fmtNum = (v: number, step: number) => {
  const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
  return v.toFixed(d).replace('-', '−')
}

/**
 * Value graph for numeric channels (shown in place of the dope-sheet lanes). The horizontal axis
 * is the shared timeline view; the vertical axis auto-fits the data. Curves are sampled through
 * `evaluateParam`, so easings, holds and overshoot are exactly what the stage renders.
 */
export function GraphLayer(props: { api: GraphApi }) {
  const { s } = props.api
  const { app } = s
  const regs = app.registries
  const project = s.project
  const focusProp = useValue(app.selection.property)
  const focusParam = useValue(s.ui.focusParam)
  const H = () => Math.max(120, props.api.height())
  const x = (t: number) => (t / FLICKS) * props.api.pps() - props.api.scrollX()

  const animatedNumeric = (inst: PropertyInstance) =>
    (regs.properties.get(inst.type)?.params ?? []).some((d) => (inst.params[d.id]?.keyframes?.length ?? 0) > 0 && regs.paramTypes.get(d.type)?.channels)

  const chans = createMemo<Chan[]>(() => {
    const c = props.api.clip()
    if (!c) return []
    const fp = focusParam()
    const prop = focusProp()
    const { width: W, height: Hh } = project().settings
    const list: Omit<Chan, 'color'>[] = []
    // A focused param wins, then the focused property's params, then just the first animated param.
    const scope: 'param' | 'property' | 'first' = fp ? 'param' : prop && c.properties.some((i) => i.id === prop && animatedNumeric(i)) ? 'property' : 'first'
    for (const inst of c.properties) {
      if (scope === 'param' ? inst.id !== fp!.propertyId : scope === 'property' ? inst.id !== prop : false) continue
      const contrib = regs.properties.get(inst.type)
      for (const def of contrib?.params ?? []) {
        if (scope === 'param' && def.id !== fp!.paramId) continue
        if (scope === 'first' && list.length && list[0].def !== def) continue
        const kfs = inst.params[def.id]?.keyframes
        const type = regs.paramTypes.get(def.type)
        if (!kfs?.length || !type?.channels || !type.interpolate) continue
        const n = type.channels(kfs[0].value).length
        for (let ch = 0; ch < n; ch++) {
          let scale = 1
          let unit = ''
          if (def.unit === 'frameX' || (def.unit === 'frameXY' && ch === 0)) (scale = W), (unit = 'px')
          else if (def.unit === 'frameY' || def.unit === 'frameLen' || (def.unit === 'frameXY' && ch === 1)) (scale = Hh), (unit = 'px')
          else if (def.unit === 'percent') (scale = 100), (unit = '%')
          else if (def.unit === 'deg') unit = '°'
          list.push({ key: `${inst.id}/${def.id}/${ch}`, inst, def, type, ch, multi: n > 1, scale, unit })
        }
      }
    }
    return list.slice(0, 12).map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }))
  })

  const read = (c: Chan, v: unknown) => (c.type.channels!(v as never)[c.ch] ?? 0) * c.scale

  /** Sampled curves for the visible time window + the value extent. */
  const curves = createMemo(() => {
    const clip = props.api.clip()
    const cs = chans()
    const out: { chan: Chan; pts: [number, number][] }[] = []
    if (!clip || !cs.length) return { out, lo: 0, hi: 1 }
    const w = props.api.laneW()
    const n = Math.max(8, Math.ceil(w / 2))
    let lo = Infinity
    let hi = -Infinity
    for (const chan of cs) {
      const pv = chan.inst.params[chan.def.id]
      const pts: [number, number][] = []
      for (let i = 0; i <= n; i++) {
        const px = props.api.scrollX() + (i / n) * w
        const local = app.view.pxToTime(px) - clip.start
        const v = read(chan, evaluateParam(regs, chan.def, pv, local))
        pts.push([i / n, v])
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      for (const k of pv?.keyframes ?? []) {
        const v = read(chan, k.value)
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      out.push({ chan, pts })
    }
    return { out, lo, hi }
  })

  const [frozen, setFrozen] = createSignal<[number, number] | null>(null)
  const domain = createMemo<[number, number]>(() => {
    if (frozen()) return frozen()!
    let { lo, hi } = curves()
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
    if (hi - lo < 1e-9) (lo -= 1), (hi += 1)
    const pad = (hi - lo) * 0.14
    return [lo - pad, hi + pad]
  })
  const y = (v: number) => H() - ((v - domain()[0]) / (domain()[1] - domain()[0])) * H()
  const unitOfValue = (py: number) => domain()[0] + ((H() - py) / H()) * (domain()[1] - domain()[0])

  const grid = createMemo(() => {
    const [lo, hi] = domain()
    const step = niceStep((hi - lo) / 5)
    const out: { v: number; label: string }[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push({ v: Math.abs(v) < step * 1e-6 ? 0 : v, label: fmtNum(v, step) })
    return out
  })

  const paths = createMemo(() =>
    curves().out.map(({ chan, pts }) => ({
      chan,
      d: pts.map(([u, v], i) => `${i ? 'L' : 'M'}${(u * props.api.laneW()).toFixed(1)} ${y(v).toFixed(1)}`).join('')
    }))
  )

  /** Keyframe points, one per channel. */
  const points = createMemo(() => {
    const clip = props.api.clip()
    if (!clip) return []
    const out: { chan: Chan; item: KfItem; v: number; ref: KfRef }[] = []
    for (const chan of chans()) {
      const kfs = chan.inst.params[chan.def.id]?.keyframes ?? []
      for (const k of kfs) {
        const ref = { clipId: clip.id, propertyId: chan.inst.id, paramId: chan.def.id, keyframeId: k.id }
        const glyph = (easingOf(regs, k.easing)?.glyph ?? 'diamond') as GlyphKind
        out.push({ chan, v: read(chan, k.value), ref, item: { id: k.id, t: k.t, glyph, easingId: k.easing?.id ?? 'linear', refs: [ref] } })
      }
    }
    return out
  })

  /** Current value at the playhead, per channel. */
  const heads = createMemo(() => {
    const clip = props.api.clip()
    if (!clip) return []
    const local = Math.min(clip.duration, Math.max(0, s.time() - clip.start))
    return chans().map((c) => ({ chan: c, v: read(c, evaluateParam(regs, c.def, c.inst.params[c.def.id], local)) }))
  })

  const [tip, setTip] = createSignal<{ x: number; y: number; text: string } | null>(null)

  const rowFor = (c: Chan): Row =>
    ({ kind: 'param', key: c.key, y: 0, inst: c.inst, def: c.def, type: c.type, pv: c.inst.params[c.def.id], animated: true, kfs: [], segs: [] }) as ParamRow

  const pointDown = (e: PointerEvent, p: ReturnType<typeof points>[number]) => {
    const d = props.api.prepareDrag(e, p.item, rowFor(p.chan))
    if (!d) return
    const td = props.api.timeDrag(d)
    let mode: 'time' | 'value' | null = null
    let valueStarted = false
    let last: unknown
    const startY = e.clientY
    const v0 = p.v
    const move = (ev: PointerEvent) => {
      if (!mode) {
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - startY
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return
        mode = Math.abs(dy) > Math.abs(dx) && d.sel.length === 1 ? 'value' : 'time'
        if (mode === 'value') setFrozen(domain())
      }
      if (mode === 'time') return td.move(ev)
      const [lo, hi] = frozen()!
      let disp = v0 - ((ev.clientY - startY) / H()) * (hi - lo)
      if (!ev.altKey) disp = Math.round(disp * 100) / 100
      let raw = disp / p.chan.scale
      if (p.chan.def.min !== undefined) raw = Math.max(p.chan.def.min, raw)
      if (p.chan.def.max !== undefined) raw = Math.min(p.chan.def.max, raw)
      const cur = p.chan.inst.params[p.chan.def.id]?.keyframes?.find((k) => k.id === p.ref.keyframeId)?.value
      const next = Array.isArray(cur) ? cur.map((n, i) => (i === p.chan.ch ? raw : n)) : raw
      last = next
      app.edit.setKeyframeValue(p.ref, next, { gesture: valueStarted ? 'update' : 'start' })
      valueStarted = true
      setTip({ x: x(d.clip.start + p.item.t), y: y(raw * p.chan.scale), text: `${+(raw * p.chan.scale).toFixed(2)}${p.chan.unit}` })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (mode === 'value') {
        if (valueStarted) app.edit.setKeyframeValue(p.ref, last, { gesture: 'end' })
        setFrozen(null)
        setTip(null)
      } else td.end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const label = (c: Chan) => `${regs.properties.get(c.inst.type)?.name ?? c.inst.type} · ${c.def.label}${c.multi ? ` ${AXIS[c.ch] ?? c.ch + 1}` : ''}`

  return (
    <div class="kf-graph" style={{ height: `${H()}px` }} onContextMenu={(e) => e.preventDefault()}>
      <svg class="kf-graph-svg" width={props.api.laneW()} height={H()}>
        <For each={grid()}>
          {(g) => <line class={`kf-graph-grid ${g.v === 0 ? 'zero' : ''}`} x1="0" x2={props.api.laneW()} y1={y(g.v)} y2={y(g.v)} />}
        </For>
        <For each={paths()}>{(p) => <path class="kf-graph-curve" d={p.d} stroke={p.chan.color} />}</For>
      </svg>
      <For each={grid()}>
        {(g) => (
          <span class="kf-graph-tick tnum" style={{ top: `${y(g.v)}px` }}>
            {g.label}
          </span>
        )}
      </For>
      <For each={heads()}>
        {(h) => (
          <i class="kf-graph-now" style={{ left: `${x(s.time())}px`, top: `${y(h.v)}px`, background: h.chan.color }} />
        )}
      </For>
      <For each={points()}>
        {(p) => {
          const sel = () => props.api.selKeys().has(refKey(p.ref))
          return (
            <div
              class={`kf-kf kf-gpt ${sel() ? 'sel' : ''}`}
              style={{ left: `${x((props.api.clip()?.start ?? 0) + p.item.t)}px`, top: `${y(p.v) - 14}px`, '--ch': p.chan.color }}
              data-tip={`${label(p.chan)} · ${+p.v.toFixed(2)}${p.chan.unit} · ${formatTimecode(p.item.t, app.fps())}`}
              onPointerDown={(e) => pointDown(e, p)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const cur = app.selection.keyframes.get()
                s.openMenu(e, cur.some((r) => refKey(r) === refKey(p.ref)) ? cur : [p.ref])
              }}
            >
              <Glyph kind={p.item.glyph} size={13} />
            </div>
          )
        }}
      </For>
      <Show when={tip()}>
        {(t) => (
          <div class="kf-dragtip tnum" style={{ left: `${t().x}px`, top: `${t().y - 36}px` }}>
            {t().text}
          </div>
        )}
      </Show>
      <div class="kf-graph-legend">
        <For each={chans()}>
          {(c) => (
            <span class="kf-graph-key">
              <i style={{ background: c.color }} />
              {label(c)}
              <Show when={c.unit}>
                <em>{c.unit}</em>
              </Show>
            </span>
          )}
        </For>
      </div>
      <Show when={chans().length === 0}>
        <div class="kf-graph-empty">Animate a numeric parameter to see its value curve here.</div>
      </Show>
    </div>
  )
}
