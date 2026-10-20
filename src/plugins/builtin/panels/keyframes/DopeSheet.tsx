import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show, Switch, Match } from 'solid-js'
import { keyframeAt, KF_EPSILON } from '@core/evaluate'
import type { CascadeAPI } from '@core/app'
import { findClip, type Clip, type Id } from '@shared/project'
import { FLICKS, flicksToFrame, formatRulerLabel, formatTimecode, rulerStep, snapToFrame, type Flicks } from '@shared/time'
import { Icon } from '@ui/icon'
import { IconButton, Empty } from '@ui/kit'
import { useValue } from '@ui/reactive'
import { GraphLayer } from './Graph'
import { Glyph } from './Glyph'
import { easingOf, miniCurve } from './curves'
import { buildRows, defaultExpansion, displayValue, refKey, resolveRefs, ROW_H, snapTime, valueAt, type Expansion, type KfItem, type KfRef, type ParamRow, type Row, type SegItem } from './model'
import type { PanelState } from './context'

export interface DragPrep {
  item: KfItem
  row: Row
  clip: Clip
  sel: KfRef[]
  collapseOnUp: boolean
  startX: number
  minT: Flicks
  maxT: Flicks
  targets: Flicks[]
}

const RULER_H = 30
const TREE_W = 220

const instOf = (r: Row) => (r.kind === 'prop' || r.kind === 'param' || r.kind === 'more' ? r.inst : null)

export function DopeSheet(props: { s: PanelState }) {
  const { app, ui } = props.s
  const project = props.s.project
  const regs = app.registries
  const selClips = useValue(app.selection.clips)
  const kfSel = useValue(app.selection.keyframes)
  const focusProp = useValue(app.selection.property)
  const focusParam = useValue(ui.focusParam)
  const pps = useValue(app.view.pxPerSecond)
  const scrollX = useValue(app.view.scrollX)
  const expansion = useValue(ui.expansion)
  const showAll = useValue(ui.showAll)
  const graph = useValue(ui.graph)

  const clip = createMemo<Clip | null>(() => {
    const p = project()
    const id = selClips()[selClips().length - 1]
    if (!id) return null
    return findClip(p.timelines[p.activeTimeline], id)?.clip ?? null
  })
  const fps = () => project().settings.fps
  const rows = createMemo<Row[]>(() => {
    const c = clip()
    if (!c) return []
    return buildRows(c, regs, {
      showAll: showAll(),
      expansion: (inst, animated) => expansion()[inst.id] ?? defaultExpansion(animated, focusProp() === inst.id)
    })
  })
  const selKeys = createMemo(() => new Set(kfSel().map(refKey)))
  const clipColor = () => (clip() ? regs.mediaTypes.get(clip()!.type)?.color : undefined) ?? 'var(--sky)'
  const x = (t: Flicks) => (t / FLICKS) * pps()
  const totalKfs = createMemo(() => rows()[0]?.kfs.length ?? 0)

  let scroller!: HTMLDivElement
  let lanes!: HTMLDivElement
  let ruler!: HTMLDivElement
  let world!: HTMLDivElement
  let playhead!: HTMLDivElement
  let rulerHead!: HTMLDivElement
  const [laneW, setLaneW] = createSignal(800)
  const [viewH, setViewH] = createSignal(300)

  // ───────────── horizontal view plumbing (shared with the timeline) ─────────────
  onMount(() => {
    const ro = new ResizeObserver(() => (setLaneW(lanes.clientWidth), setViewH(scroller.clientHeight - RULER_H)))
    ro.observe(lanes)
    ro.observe(scroller)
    setLaneW(lanes.clientWidth)
    setViewH(scroller.clientHeight - RULER_H)
    onCleanup(() => ro.disconnect())
  })
  createEffect(() => {
    if (props.s.visible() && laneW() > 0) app.view.viewportWidth.set(laneW())
  })
  createEffect(() => {
    world.style.transform = `translate3d(${-scrollX()}px,0,0)`
  })

  // Playhead: two elements moved by transform, driven straight from the playback clock.
  const placeHead = () => {
    const t = app.playback.time.get()
    const px = (t / FLICKS) * app.view.pxPerSecond.get()
    playhead.style.transform = `translate3d(${px}px,0,0)`
    const rx = px - app.view.scrollX.get()
    rulerHead.style.transform = `translate3d(${rx}px,0,0)`
    rulerHead.style.opacity = rx < -40 || rx > lanes.clientWidth + 40 ? '0' : '1'
    rulerHead.firstElementChild!.textContent = formatTimecode(t, app.fps())
  }
  // Follow the playhead like the timeline does (the timeline is hidden while this tab is in front).
  const follow = (t: Flicks) => {
    const w = laneW()
    if (!props.s.visible() || w <= 0) return
    const px = (t / FLICKS) * app.view.pxPerSecond.get() - app.view.scrollX.get()
    if (app.playback.playing.get()) {
      if (app.settings.get<boolean>('timeline.followPlayhead') !== false && (px > w - 40 || px < 0)) app.view.scrollX.set(Math.max(0, px + app.view.scrollX.get() - w * 0.1))
    } else if (px > w || px < 0) app.view.scrollX.set(Math.max(0, px + app.view.scrollX.get() - w * 0.5))
  }
  onMount(() => {
    placeHead()
    const subs = [app.playback.time.subscribe(placeHead), app.playback.time.subscribe(follow), app.view.pxPerSecond.subscribe(placeHead), app.view.scrollX.subscribe(placeHead)]
    onCleanup(() => subs.forEach((d) => d.dispose()))
  })
  createEffect(() => {
    if (props.s.visible()) placeHead()
  })

  // When another clip is shown, bring it into the (shared) horizontal view if it's off screen.
  let revealed: Id | null = null
  createEffect(() => {
    const c = clip()
    if (!c || c.id === revealed) return
    revealed = c.id
    const w = laneW()
    const left = app.view.scrollX.get()
    const a = (c.start / FLICKS) * app.view.pxPerSecond.get()
    const b = ((c.start + c.duration) / FLICKS) * app.view.pxPerSecond.get()
    if (b < left || a > left + w) app.view.scrollX.set(Math.max(0, a - 48))
  })

  const fit = () => {
    const c = clip()
    if (!c) return
    const pad = 36
    const w = Math.max(80, laneW() - pad * 2)
    const next = Math.min(4000, Math.max(0.02, (w / c.duration) * FLICKS))
    app.view.pxPerSecond.set(next)
    app.view.scrollX.set(Math.max(0, (c.start / FLICKS) * next - pad))
  }
  ui.fit.current = fit
  onCleanup(() => {
    if (ui.fit.current === fit) ui.fit.current = null
  })

  const onWheel = (e: WheelEvent, vertical: boolean) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      app.view.zoomAround(Math.exp(-e.deltaY * 0.0022), e.clientX - lanes.getBoundingClientRect().left)
      return
    }
    const overflowing = scroller.scrollHeight > scroller.clientHeight + 1
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !vertical || !overflowing
    if (!horizontal) return
    e.preventDefault()
    const d = e.deltaX !== 0 ? e.deltaX : e.deltaY
    app.view.scrollX.set(Math.max(0, app.view.scrollX.get() + d))
  }
  onMount(() => {
    const lw = (e: WheelEvent) => onWheel(e, true)
    const rw = (e: WheelEvent) => onWheel(e, false)
    lanes.addEventListener('wheel', lw, { passive: false })
    ruler.addEventListener('wheel', rw, { passive: false })
    onCleanup(() => {
      lanes.removeEventListener('wheel', lw)
      ruler.removeEventListener('wheel', rw)
    })
  })

  // ───────────── ruler ─────────────
  const ticks = createMemo(() => {
    const p = pps()
    const f = fps()
    const { major, minor } = rulerStep(p, f, 96)
    const sx = scrollX()
    const t0 = Math.max(0, (sx / p) * FLICKS)
    const t1 = ((sx + laneW()) / p) * FLICKS
    const ratio = Math.max(1, Math.round(major / minor))
    const i0 = Math.floor(t0 / minor)
    const i1 = Math.min(Math.ceil(t1 / minor), i0 + 700)
    const out: { x: number; major: boolean; label: string }[] = []
    for (let i = i0; i <= i1; i++) {
      const t = Math.round(i * minor)
      const isMajor = i % ratio === 0
      out.push({ x: (t / FLICKS) * p - sx, major: isMajor, label: isMajor ? formatRulerLabel(t, f, major) : '' })
    }
    return { list: out, majorPx: (major / FLICKS) * p, minorPx: (minor / FLICKS) * p }
  })

  const timeAtClientX = (cx: number): Flicks => app.view.pxToTime(cx - lanes.getBoundingClientRect().left + app.view.scrollX.get())

  const rulerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const seek = (ev: PointerEvent) => app.playback.seek(snapToFrame(Math.max(0, timeAtClientX(ev.clientX)), fps()))
    seek(e)
    const up = () => {
      el.removeEventListener('pointermove', seek)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', seek)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // ───────────── selection helpers ─────────────
  const focus = (inst: { id: Id } | null, paramId?: string) => {
    if (!inst) return
    app.selection.property.set(inst.id)
    ui.focusParam.set(paramId ? { propertyId: inst.id, paramId } : null)
  }
  const isSel = (refs: KfRef[]) => refs.length > 0 && refs.every((r) => selKeys().has(refKey(r)))
  const someSel = (refs: KfRef[]) => refs.some((r) => selKeys().has(refKey(r)))

  const [guide, setGuide] = createSignal<Flicks | null>(null)
  const [dragTip, setDragTip] = createSignal<{ t: Flicks; y: number } | null>(null)
  const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null)

  /** Snap targets (timeline time) for a keyframe drag: the playhead, clip edges and unselected keyframes. */
  const snapTargets = (c: Clip, moving: Set<string>): Flicks[] => {
    const out: Flicks[] = [app.playback.time.get(), c.start, c.start + c.duration]
    for (const inst of c.properties)
      for (const [pid, pv] of Object.entries(inst.params))
        for (const k of pv.keyframes ?? []) if (!moving.has(`${inst.id}/${pid}/${k.id}`)) out.push(c.start + k.t)
    return out
  }

  /** Selection side of a keyframe press (click / shift-click / start of a drag). Null = nothing to drag. */
  const prepareDrag = (e: PointerEvent, item: KfItem, row: Row): DragPrep | null => {
    if (e.button !== 0 && e.button !== 2) return null
    const c = clip()
    if (!c) return null
    e.stopPropagation()
    const cur = app.selection.keyframes.get()
    const curKeys = new Set(cur.map(refKey))
    const itemSel = item.refs.every((r) => curKeys.has(refKey(r)))
    focus(instOf(row), row.kind === 'param' ? row.def.id : undefined)
    if (e.button === 2) {
      if (!itemSel) app.selection.keyframes.set(item.refs)
      return null
    }
    e.preventDefault()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    let collapseOnUp = false
    if (additive) {
      if (itemSel) {
        const drop = new Set(item.refs.map(refKey))
        app.selection.keyframes.set(cur.filter((r) => !drop.has(refKey(r))))
        return null
      }
      app.selection.keyframes.set([...cur, ...item.refs.filter((r) => !curKeys.has(refKey(r)))])
    } else if (!itemSel) app.selection.keyframes.set(item.refs)
    else collapseOnUp = cur.length > item.refs.length

    const sel = app.selection.keyframes.get()
    const snap = resolveRefs(project(), project().activeTimeline, sel)
    if (!snap.length) return null
    return {
      item,
      row,
      clip: c,
      sel,
      collapseOnUp,
      startX: e.clientX,
      minT: Math.min(...snap.map((s) => s.kf.t)),
      maxT: Math.max(...snap.map((s) => s.kf.t)),
      targets: snapTargets(c, new Set(sel.map(refKey)))
    }
  }

  /** Horizontal drag of the prepared selection: frame snapping, snapping to the playhead / other keyframes, Alt = free. */
  const timeDrag = (d: DragPrep) => {
    let started = false
    let applied = 0
    return {
      move(ev: PointerEvent) {
        const dx = ev.clientX - d.startX
        if (!started && Math.abs(dx) < 3) return
        const want = d.clip.start + d.item.t + app.view.pxToTime(dx)
        const s = snapTime({ t: want, fps: fps(), pxPerSecond: app.view.pxPerSecond.get(), targets: d.targets, free: ev.altKey })
        const raw = s.t - d.clip.start - d.item.t
        const delta = Math.max(-d.minT, Math.min(d.clip.duration - d.maxT, raw))
        const step = delta - applied
        if (!started || step !== 0) app.edit.moveKeyframes(d.sel, step, { gesture: started ? 'update' : 'start' })
        started = true
        applied = delta
        setGuide(s.target !== null && delta === raw ? s.target : null)
        setDragTip({ t: d.clip.start + d.item.t + delta, y: d.row.y })
      },
      end() {
        setGuide(null)
        setDragTip(null)
        if (started) app.edit.moveKeyframes(d.sel, 0, { gesture: 'end' })
        else if (d.collapseOnUp) app.selection.keyframes.set(d.item.refs)
      }
    }
  }

  const kfDown = (e: PointerEvent, item: KfItem, row: Row) => {
    const d = prepareDrag(e, item, row)
    if (!d) return
    const td = timeDrag(d)
    const up = () => {
      window.removeEventListener('pointermove', td.move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      td.end()
    }
    window.addEventListener('pointermove', td.move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const kfMenu = (e: MouseEvent, item: KfItem) => {
    e.preventDefault()
    e.stopPropagation()
    const sel = app.selection.keyframes.get()
    const keys = new Set(sel.map(refKey))
    const refs = item.refs.every((r) => keys.has(refKey(r))) ? sel : item.refs
    props.s.openMenu(e, refs)
  }

  /** Box-select (marquee) on empty lane space; a plain click clears the keyframe selection. */
  const lanesDown = (e: PointerEvent) => {
    if (e.button !== 0 || graph() || (e.target as Element).closest('.kf-kf')) return
    const c = clip()
    if (!c) return
    e.preventDefault()
    const rect = lanes.getBoundingClientRect()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const base = additive ? app.selection.keyframes.get() : []
    const x0 = e.clientX - rect.left
    const y0 = e.clientY - rect.top
    const row0 = rows()[Math.floor(y0 / ROW_H)]
    if (row0) focus(instOf(row0), row0.kind === 'param' ? row0.def.id : undefined)
    let moved = false
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left
      const y1 = ev.clientY - rect.top
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return
      moved = true
      const left = Math.min(x0, x1)
      const right = Math.max(x0, x1)
      const top = Math.min(y0, y1)
      const bottom = Math.max(y0, y1)
      setMarquee({ x: left, y: top, w: right - left, h: bottom - top })
      const sx = app.view.scrollX.get()
      const hits = new Map<string, KfRef>()
      for (const r of rows()) {
        if (r.y + ROW_H < top || r.y > bottom) continue
        for (const k of r.kfs) {
          const px = x(c.start + k.t) - sx
          if (px >= left - 6 && px <= right + 6) for (const ref of k.refs) hits.set(refKey(ref), ref)
        }
      }
      const out = new Map(base.map((r) => [refKey(r), r]))
      for (const [k, v] of hits) out.set(k, v)
      app.selection.keyframes.set([...out.values()])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setMarquee(null)
      if (!moved && !additive) app.selection.keyframes.set([])
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const lanesDouble = (e: MouseEvent) => {
    const c = clip()
    if (!c || graph() || (e.target as Element).closest('.kf-kf')) return
    const rect = lanes.getBoundingClientRect()
    const row = rows()[Math.floor((e.clientY - rect.top) / ROW_H)]
    if (!row || row.kind !== 'param') return
    const t = Math.min(c.duration, Math.max(0, snapToFrame(timeAtClientX(e.clientX), fps()) - c.start))
    app.edit.addKeyframe(c.id, row.inst.id, row.def.id, t, valueAt(app, row.def, row.pv, t))
    const added = resolveRefsAt(c.id, row, t)
    if (added) app.selection.keyframes.set([added])
  }
  const resolveRefsAt = (clipId: Id, row: ParamRow, t: Flicks): KfRef | null => {
    const p = project()
    const c = findClip(p.timelines[p.activeTimeline], clipId)?.clip
    const kf = c?.properties.find((i) => i.id === row.inst.id)?.params[row.def.id]?.keyframes?.find((k) => Math.abs(k.t - t) <= KF_EPSILON)
    return kf ? { clipId, propertyId: row.inst.id, paramId: row.def.id, keyframeId: kf.id } : null
  }

  const setExpansion = (id: Id, e: Expansion) => ui.expansion.set({ ...ui.expansion.get(), [id]: e })
  const toggleProp = (row: Extract<Row, { kind: 'prop' }>) => {
    if (row.expansion !== 'collapsed') setExpansion(row.inst.id, 'collapsed')
    else setExpansion(row.inst.id, row.animatedCount > 0 ? 'animated' : 'all')
  }

  // ───────────── per-row pieces ─────────────
  const local = () => {
    const c = clip()
    return c ? Math.min(c.duration, Math.max(0, props.s.time() - c.start)) : 0
  }
  const inClip = () => {
    const c = clip()
    return !!c && props.s.time() >= c.start && props.s.time() <= c.start + c.duration
  }

  function ValueReadout(p: { row: () => ParamRow }) {
    const text = createMemo(() => {
      const r = p.row()
      const v = valueAt(app, r.def, r.pv, local())
      return { text: displayValue(r.def, r.type, v, project()), color: r.def.type === 'color' && typeof v === 'string' ? v : null }
    })
    return (
      <span class="kf-val tnum" title={text().text}>
        <Show when={text().color}>
          <i class="kf-swatch" style={{ background: text().color! }} />
        </Show>
        {text().text}
      </span>
    )
  }

  function AddButton(p: { row: () => ParamRow }) {
    const keyed = createMemo(() => !!keyframeAt(p.row().pv, local()) && inClip())
    return (
      <button
        class={`kf-add ${keyed() ? 'keyed' : ''} ${p.row().animated ? 'animated' : ''}`}
        disabled={!inClip()}
        data-tip={!inClip() ? 'Move the playhead into the clip' : keyed() ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          const r = p.row()
          const c = clip()
          if (!c) return
          app.edit.toggleKeyframe(c.id, r.inst.id, r.def.id)
          focus(r.inst, r.def.id)
        }}
      >
        <Glyph kind="diamond" size={13} />
      </button>
    )
  }

  function TreeRow(p: { row: () => Row }) {
    return (
      <div
        class={`kf-trow ${p.row().kind} ${instOf(p.row())?.id === focusProp() ? 'focus' : ''} ${instOf(p.row()) && !instOf(p.row())!.enabled ? 'off' : ''}`}
        style={{ top: `${p.row().y}px` }}
      >
        <Switch>
          <Match when={p.row().kind === 'clip'}>
            <Icon name={regs.mediaTypes.get(clip()?.type ?? '')?.icon ?? 'layers'} size={13} class="kf-ico" />
            <span class="kf-name">{clip()?.name}</span>
            <span class="kf-count tnum">{totalKfs() ? `${totalKfs()} keyframe${totalKfs() === 1 ? '' : 's'}` : ''}</span>
          </Match>
          <Match when={p.row().kind === 'prop'}>
            {(() => {
              const r = () => p.row() as Extract<Row, { kind: 'prop' }>
              return (
                <div class="kf-prop-head" onClick={() => focus(r().inst)}>
                  <button class={`kf-caret ${r().expansion === 'collapsed' ? '' : 'open'}`} onClick={(e) => (e.stopPropagation(), toggleProp(r()))}>
                    <Icon name="chevron-right" size={12} stroke={2.2} />
                  </button>
                  <Icon name={r().contrib?.icon ?? 'sliders-horizontal'} size={13} class="kf-ico" />
                  <span class="kf-name">{r().contrib?.name ?? r().inst.type}</span>
                  <Show when={r().animatedCount > 0}>
                    <span class="kf-chip tnum" data-tip={`${r().animatedCount} animated parameter${r().animatedCount === 1 ? '' : 's'}`}>
                      {r().animatedCount}
                    </span>
                  </Show>
                </div>
              )
            })()}
          </Match>
          <Match when={p.row().kind === 'param'}>
            {(() => {
              const r = () => p.row() as ParamRow
              return (
                <div class={`kf-param ${r().animated ? 'animated' : ''} ${focusParam()?.propertyId === r().inst.id && focusParam()?.paramId === r().def.id ? 'pfocus' : ''}`} onClick={() => focus(r().inst, r().def.id)}>
                  <span class="kf-plabel">{r().def.label}</span>
                  <ValueReadout row={r} />
                  <AddButton row={r} />
                </div>
              )
            })()}
          </Match>
          <Match when={p.row().kind === 'more'}>
            {(() => {
              const r = () => p.row() as Extract<Row, { kind: 'more' }>
              return (
                <button class="kf-more" onClick={() => setExpansion(r().inst.id, r().open ? 'animated' : 'all')}>
                  <Icon name={r().open ? 'chevrons-up' : 'chevrons-down'} size={12} />
                  {r().open ? 'Animated only' : `Show all · ${r().count}`}
                </button>
              )
            })()}
          </Match>
        </Switch>
      </div>
    )
  }

  function SegBar(p: { seg: () => SegItem; row: () => Row }) {
    const w = () => Math.max(0, x(p.seg().b) - x(p.seg().a))
    const curve = createMemo(() => (p.row().kind === 'param' && !p.seg().hold && !p.seg().flat && w() > 26 ? miniCurve(regs, p.seg().easing, 28) : null))
    return (
      <div
        class={`kf-seg ${p.row().kind === 'param' ? 'param' : 'sum'} ${p.seg().hold ? 'hold' : ''} ${p.seg().flat ? 'flat' : ''} ${someSel(p.seg().startRefs) ? 'sel' : ''}`}
        style={{ left: `${x((clip()?.start ?? 0) + p.seg().a)}px`, width: `${w()}px` }}
      >
        <Show when={curve()}>
          {(cv) => (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <path d={cv().d} vector-effect="non-scaling-stroke" />
            </svg>
          )}
        </Show>
      </div>
    )
  }

  function KfGlyph(p: { item: KfItem; row: () => Row }) {
    const sel = () => isSel(p.item.refs)
    const partial = () => !sel() && someSel(p.item.refs)
    const atHead = () => Math.abs((clip()?.start ?? 0) + p.item.t - props.s.time()) <= KF_EPSILON
    const tip = () => {
      const e = easingOf(regs, { id: p.item.easingId })
      const base = `${formatTimecode(p.item.t, fps())}`
      return p.row().kind === 'param' ? `${e?.name ?? p.item.easingId} · ${base}` : `${p.item.refs.length} keyframe${p.item.refs.length === 1 ? '' : 's'} · ${base}`
    }
    return (
      <div
        class={`kf-kf ${p.row().kind === 'param' ? '' : 'sum'} ${sel() ? 'sel' : ''} ${partial() ? 'partial' : ''} ${atHead() ? 'head' : ''}`}
        style={{ left: `${x((clip()?.start ?? 0) + p.item.t)}px` }}
        data-tip={tip()}
        onPointerDown={(e) => kfDown(e, p.item, p.row())}
        onContextMenu={(e) => kfMenu(e, p.item)}
        onDblClick={(e) => {
          e.stopPropagation()
          const c = clip()
          if (c) (app.playback.pause(), app.playback.seek(c.start + p.item.t))
        }}
      >
        <Glyph kind={p.item.glyph} size={p.row().kind === 'param' ? 15 : 14} />
      </div>
    )
  }

  const height = () => rows().length * ROW_H

  return (
    <>
      <div class="kf-sheet" style={{ '--kf-clip': clipColor() }}>
        <div class="kf-scroller" ref={scroller}>
          <div class="kf-grid" style={{ 'grid-template-columns': `${TREE_W}px minmax(0, 1fr)`, 'grid-template-rows': `${RULER_H}px 1fr` }}>
            <div class="kf-corner">
              <span class="kf-dot" />
              <span class="kf-corner-name">{clip()?.name}</span>
              <Show when={selClips().length > 1}>
                <span class="kf-chip" data-tip={`Showing the last of ${selClips().length} selected clips`}>
                  +{selClips().length - 1}
                </span>
              </Show>
              <div class="kf-fill" />
              <IconButton
                size="sm"
                icon="list-tree"
                active={showAll()}
                tip={showAll() ? 'Showing all parameters' : 'Show all parameters'}
                onClick={() => ui.showAll.set(!ui.showAll.get())}
              />
            </div>
            <div class="kf-ruler" ref={ruler} onPointerDown={rulerDown}>
              <Show when={clip()}>
                <div class="kf-ruler-clip" style={{ left: `${x(clip()!.start) - scrollX()}px`, width: `${x(clip()!.duration)}px` }} />
              </Show>
              <Index each={ticks().list}>
                {(t) => (
                  <div class={`kf-tick ${t().major ? 'major' : ''}`} style={{ left: `${t().x}px` }}>
                    <Show when={t().label}>
                      <span class="tnum">{t().label}</span>
                    </Show>
                  </div>
                )}
              </Index>
              <div class="kf-rhead" ref={rulerHead}>
                <span class="kf-rhead-tc tnum" />
              </div>
            </div>

            <div class="kf-tree" style={{ height: `${height()}px` }}>
              <Index each={rows()}>{(row) => <TreeRow row={row} />}</Index>
            </div>

            <div class={`kf-lanes ${graph() ? 'graph-mode' : ''}`} ref={lanes} onPointerDown={lanesDown} onDblClick={lanesDouble}>
              <div
                class="kf-bg"
                style={{
                  'background-size': `${ticks().majorPx}px 100%, ${ticks().minorPx}px 100%`,
                  'background-position': `${-scrollX()}px 0, ${-scrollX()}px 0`
                }}
              />
              <Index each={rows()}>
                {(row) => <div class={`kf-stripe ${row().kind} ${instOf(row()) && instOf(row())!.id === focusProp() ? 'focus' : ''}`} style={{ top: `${row().y}px` }} />}
              </Index>
              <div class="kf-world" ref={world}>
                <Show when={clip()}>
                  <div class="kf-span" style={{ left: `${x(clip()!.start)}px`, width: `${x(clip()!.duration)}px` }} />
                </Show>
                <Index each={rows()}>
                  {(row) => (
                    <div class={`kf-lrow ${row().kind}`} style={{ top: `${row().y}px` }}>
                      <Index each={row().segs}>{(seg) => <SegBar seg={seg} row={row} />}</Index>
                      <Index each={row().kfs}>{(item) => <KfGlyph item={item()} row={row} />}</Index>
                    </div>
                  )}
                </Index>
                <Show when={guide() !== null}>
                  <div class="kf-guide" style={{ left: `${x(guide()!)}px` }} />
                </Show>
                <Show when={dragTip()}>
                  {(tip) => (
                    <div class="kf-dragtip tnum" style={{ left: `${x(tip().t)}px`, top: `${Math.max(2, tip().y - 22)}px` }}>
                      {formatTimecode(tip().t, fps())}
                      <span class="kf-dragtip-f">f{flicksToFrame(tip().t, fps())}</span>
                    </div>
                  )}
                </Show>
                <div class="kf-playhead" ref={playhead} />
              </div>
              <Show when={graph() && clip()}>
                <GraphLayer
                  api={{ s: props.s, clip, scrollX, pps, laneW, height: viewH, selKeys, prepareDrag, timeDrag }}
                />
              </Show>
              <Show when={marquee()}>
                {(m) => <div class="kf-marquee" style={{ left: `${m().x}px`, top: `${m().y}px`, width: `${m().w}px`, height: `${m().h}px` }} />}
              </Show>
              <Show when={totalKfs() === 0 && !graph()}>
                <div class="kf-hint">
                  <Glyph kind="diamond" size={12} />
                  Press <b>◆</b> beside a parameter, or double-click its lane, to add a keyframe
                </div>
              </Show>
            </div>
          </div>
        </div>
        <HScroll app={app} laneW={laneW} scrollX={scrollX} pps={pps} clipEnd={() => (clip() ? clip()!.start + clip()!.duration : 0)} />
      </div>
      <Show when={!clip()}>
        <div class="kf-empty">
          <Empty icon="diamond" title="No clip selected" hint="Select a clip on the timeline to see and edit its keyframes." />
        </div>
      </Show>
    </>
  )
}

/** Horizontal scrollbar for the shared timeline view, under the keyframe lanes. */
function HScroll(props: { app: CascadeAPI; laneW: () => number; scrollX: () => number; pps: () => number; clipEnd: () => Flicks }) {
  const app = props.app
  const total = () => Math.max((Math.max(app.duration(), props.clipEnd()) / FLICKS) * props.pps() + props.laneW() * 0.5, props.scrollX() + props.laneW(), 1)
  const thumbW = () => Math.max(24, (props.laneW() / total()) * props.laneW())
  const thumbX = () => (props.scrollX() / Math.max(1, total() - props.laneW())) * (props.laneW() - thumbW())
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const track = e.currentTarget as HTMLElement
    const onThumb = (e.target as HTMLElement).classList.contains('kf-hscroll-thumb')
    const r = track.getBoundingClientRect()
    const range = () => Math.max(1, props.laneW() - thumbW())
    const span = () => Math.max(0, total() - props.laneW())
    // Clicking the track jumps the thumb's centre there; then drag from wherever it lands.
    if (!onThumb) app.view.scrollX.set(Math.max(0, ((e.clientX - r.left - thumbW() / 2) / range()) * span()))
    const x0 = e.clientX
    const s0 = app.view.scrollX.get()
    const move = (ev: PointerEvent) => app.view.scrollX.set(Math.max(0, Math.min(span(), s0 + ((ev.clientX - x0) / range()) * span())))
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div class="kf-hscroll" style={{ 'margin-left': `${TREE_W}px` }} onPointerDown={down}>
      <div class="kf-hscroll-thumb" style={{ width: `${thumbW()}px`, transform: `translateX(${thumbX()}px)` }} />
    </div>
  )
}
