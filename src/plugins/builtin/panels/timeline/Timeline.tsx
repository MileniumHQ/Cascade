import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { ClipBodyContext, PanelContext, PopupMenuItem, TimelineDecorationContext, TimelineToolContext } from '@core/plugin-api'
import { Emitter } from '@core/events'
import { shallowArrayEqual } from '@core/value'
import { clipKeyframeTimes } from '@core/evaluate'
import { clipsInRange, expandLinked, type MoveRequest } from '@core/timeline-ops'
import { collectSnapPoints } from '@core/snap'
import { resolveTarget, SOURCE_RANGE_MIME } from '@core/three-point'
import { clipEnd, findClip, type Clip, type Id, type Track } from '@shared/project'
import { FLICKS, formatTimecode, snapToFrame, type Flicks } from '@shared/time'
import { Icon } from '@ui/icon'
import { openContextMenu, type MenuItem } from '@ui/kit'
import { useProject, useRegistry, useValue } from '@ui/reactive'
import { drawRuler } from './ruler'
import { TimelineTabs } from './TimelineTabs'
import { Decorations } from './decorations'
import { linkedSelection } from './state'
export { linkedSelection } from './state'

export const HEADER_W = 184
const RULER_H = 30
const SNAP_PX = 8
const EDGE_PX = 6
const DEFAULT_H = { visual: 64, audio: 52 }

interface Row {
  track: Track
  y: number
  h: number
  label: string
}

interface DragState {
  ids: Set<Id>
  dt: Flicks
  /** Track shift in rows among tracks of the same kind (for the grabbed clip's kind). */
  shift: number
  kind: 'visual' | 'audio'
  snapAt: Flicks | null
}

export function Timeline(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const project = useProject(app)
  const pps = useValue(app.view.pxPerSecond)
  const scrollX = useValue(app.view.scrollX)
  const selected = useValue(app.selection.clips)
  const targetTrack = useValue(app.selection.track)
  const tool = useValue(app.view.tool)
  const tools = useRegistry(app.registries.timelineTools)
  const activeTool = () => tools().find((t) => t.id === tool())
  const [toolTip, setToolTip] = createSignal<{ text: string; x: number; y: number } | null>(null)
  let toolCleanup: (() => void) | undefined
  onCleanup(() => toolCleanup?.())
  const snapping = useValue(app.view.snapping)
  const [width, setWidth] = createSignal(800)
  const [drag, setDrag] = createSignal<DragState | null>(null)
  const [snapLine, setSnapLine] = createSignal<Flicks | null>(null)
  const [marquee, setMarquee] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [drop, setDrop] = createSignal<{ t: Flicks; row: Row | null } | null>(null)
  const [hoverT, setHoverT] = createSignal<Flicks | null>(null)
  const [resizing, setResizing] = createSignal<{ id: Id; h: number } | null>(null)

  let root!: HTMLDivElement
  let scroller!: HTMLDivElement
  let rowsEl!: HTMLDivElement
  let ruler!: HTMLCanvasElement
  let playhead!: HTMLDivElement
  let playheadHead!: HTMLDivElement

  const tl = () => project().timelines[project().activeTimeline]
  const selSet = createMemo(() => new Set(selected()))

  const rows = createMemo<Row[]>(() => {
    const t = tl()
    if (!t) return []
    const vis = t.tracks.filter((x) => x.kind === 'visual').reverse()
    const aud = t.tracks.filter((x) => x.kind === 'audio')
    const r = resizing()
    let y = 0
    const out: Row[] = []
    const push = (track: Track) => {
      const h = r?.id === track.id ? r.h : (track.height ?? DEFAULT_H[track.kind])
      out.push({ track, y, h, label: track.name })
      y += h
    }
    vis.forEach(push)
    y += 6 // divider between video and audio
    aud.forEach(push)
    return out
  })
  const rowIds = createMemo(() => rows().map((r) => r.track.id), [] as Id[], { equals: shallowArrayEqual })
  const rowById = createMemo(() => new Map(rows().map((r) => [r.track.id, r])))
  const totalH = () => {
    const r = rows()
    const last = r[r.length - 1]
    return last ? last.y + last.h + 40 : 0
  }

  // visible time window (+ margin)
  const t0 = () => app.view.pxToTime(Math.max(0, scrollX() - 200))
  const t1 = () => app.view.pxToTime(scrollX() + width() + 200)
  const x = (t: Flicks) => (t / FLICKS) * pps() - scrollX()

  // Read project() so this tracks edits; app.duration() isn't reactive.
  const contentW = () => (project() && app.duration() / FLICKS) * pps()
  const maxScroll = () => Math.max(0, contentW() + width() * 0.5 - width())
  const setScroll = (v: number) => app.view.scrollX.set(Math.max(0, Math.min(maxScroll() + width() * 0.5, v)))

  // ───────── ruler + playhead (imperative for speed) ─────────
  const redrawRuler = () => {
    const t = tl()
    if (!t || !ruler) return
    drawRuler(ruler, app, { inPoint: t.inPoint, outPoint: t.outPoint })
  }
  const placePlayhead = () => {
    const px = app.view.timeToPx(app.playback.time.get()) - app.view.scrollX.get()
    const vis = px >= -1 && px <= width() + 1
    playhead.style.display = playheadHead.style.display = vis ? '' : 'none'
    playhead.style.transform = `translateX(${Math.round(px)}px)`
    playheadHead.style.transform = `translateX(${Math.round(px)}px)`
  }

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth - HEADER_W
      // Hidden behind another bottom tab: keep the last width so the shared view isn't clobbered.
      if (w <= 0) return
      setWidth(w)
      app.view.viewportWidth.set(w)
      redrawRuler()
      placePlayhead()
    })
    ro.observe(root)
    const subs = [
      app.playback.time.subscribe((t) => {
        placePlayhead()
        if (!root.clientWidth) return // the keyframes tab follows the playhead while it's in front
        const px = app.view.timeToPx(t) - app.view.scrollX.get()
        if (app.playback.playing.get()) {
          if (app.settings.get<boolean>('timeline.followPlayhead') !== false && (px > width() - 40 || px < 0)) setScroll(app.view.timeToPx(t) - width() * 0.1)
        } else if (px > width() || px < 0) {
          // A paused jump off-screen (timecode entry, Home/End, agents) centres the playhead.
          setScroll(app.view.timeToPx(t) - width() * 0.5)
        }
      }),
      app.view.pxPerSecond.subscribe(() => (redrawRuler(), placePlayhead())),
      app.view.scrollX.subscribe(() => (redrawRuler(), placePlayhead())),
      app.doc.onChange.on(redrawRuler)
    ]
    redrawRuler()
    placePlayhead()
    // First open: fit the edit if it's tiny or huge.
    if (app.duration() > 0 && contentW() > 0 && (contentW() < width() * 0.25 || contentW() > width() * 40)) app.run('timeline.zoomFit')
    onCleanup(() => {
      ro.disconnect()
      subs.forEach((s) => s.dispose())
    })
  })

  // ───────── coordinate helpers ─────────
  const laneRect = () => rowsEl.getBoundingClientRect()
  const timeAt = (clientX: number) => app.view.pxToTime(clientX - laneRect().left - HEADER_W + app.view.scrollX.get())
  const rowAt = (clientY: number): Row | null => {
    const y = clientY - laneRect().top
    return rows().find((r) => y >= r.y && y < r.y + r.h) ?? null
  }
  const snapThreshold = () => app.view.pxToTime(SNAP_PX)
  const snapTo = (t: Flicks, exclude: Set<Id>, alt: boolean): { t: Flicks; at: Flicks | null } => {
    if (!snapping() || alt) return { t: snapToFrame(t, app.fps()), at: null }
    const pts = collectSnapPoints(app, exclude, [app.playback.time.get()])
    let best: Flicks | null = null
    let bd = snapThreshold()
    for (const p of pts) {
      const d = Math.abs(p - t)
      if (d <= bd) {
        bd = d
        best = p
      }
    }
    return best === null ? { t: snapToFrame(t, app.fps()), at: null } : { t: best, at: best }
  }

  // ───────── decorations (markers, transition chips… contributed by plugins) ─────────
  const viewChanges = new Emitter<void>()
  createEffect(on([pps, scrollX, width, project], () => viewChanges.emit()))
  const decoBase = {
    timeAt: (px: number) => app.view.pxToTime(px + app.view.scrollX.get()),
    snap: (t: Flicks, ex?: Set<Id>, disable?: boolean) => snapTo(t, ex ?? new Set(), !!disable).t,
    showSnapGuide: (t: Flicks | null) => setSnapLine(t)
  }
  const laneGeometry = (height: () => number, track: () => Track | null = () => null): Omit<TimelineDecorationContext, 'app' | 'target'> => ({
    ...decoBase,
    x: (t) => app.view.timeToPx(t) - app.view.scrollX.get(),
    width: () => width(),
    height,
    range: () => ({ start: app.view.pxToTime(app.view.scrollX.get()), end: app.view.pxToTime(app.view.scrollX.get() + width()) }),
    track,
    clip: () => null,
    subscribe: (fn) => { const d = viewChanges.on(fn); return () => d.dispose() }
  })

  // ───────── selection ─────────
  const selectClip = (id: Id, e: PointerEvent | MouseEvent) => {
    const withLinks = linkedSelection.get() && !e.altKey
    const ids = withLinks ? [...expandLinked(tl(), [id])] : [id]
    const cur = app.selection.clips.get()
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const has = cur.includes(id)
      app.selection.setClips(has ? cur.filter((c) => !ids.includes(c)) : [...cur.filter((c) => !ids.includes(c)), ...ids.filter((x) => x !== id), id])
    } else if (!cur.includes(id)) {
      app.selection.setClips([...ids.filter((x) => x !== id), id])
    } else {
      // keep multi-selection (pulling in any unselected linked partners) but make this primary
      app.selection.setClips([...new Set([...cur, ...ids])].filter((c) => c !== id).concat(id))
    }
  }

  // ───────── pointer interactions on lanes ─────────
  const onLaneDown = (e: PointerEvent) => {
    if (e.button === 1) return panStart(e)
    if (e.button !== 0) return
    const row = rowAt(e.clientY)
    if (row) app.selection.track.set(row.track.id)
    const hitTest: TimelineToolContext['hitTest'] = (clientX, clientY) => {
      const r = rowAt(clientY)
      if (!r) return null
      const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null
      const clipEl = element?.closest<HTMLElement>('.tl-clip')
      return { trackId: r.track.id, clipId: clipEl?.dataset.id, edge: element?.dataset.edge as 'start' | 'end' | undefined }
    }
    const hit = hitTest(e.clientX, e.clientY)
    if (hit?.clipId && findClip(tl(), hit.clipId)?.track.locked) return
    if (hit?.clipId || tool() !== 'select') {
      toolCleanup?.()
      toolCleanup = activeTool()?.pointerDown(e, {
        app, hitTest, timeAt, clientXAt: (t) => laneRect().left + HEADER_W + x(t),
        snap: (t, exclude, disable) => snapTo(t, exclude, disable).t,
        selectClip, moveClip: (ev, id) => { const f = findClip(tl(), id); if (f) return moveStart(ev, id, f.track) },
        trimClip: trimStart,
        feedback: (text, ev) => setToolTip(text ? { text, x: (ev?.clientX ?? e.clientX) - root.getBoundingClientRect().left + 12, y: (ev?.clientY ?? e.clientY) - root.getBoundingClientRect().top + 18 } : null)
      }) || undefined
      return
    }
    marqueeStart(e)
  }

  function panStart(e: PointerEvent) {
    e.preventDefault()
    const sx = app.view.scrollX.get()
    const sy = scroller.scrollTop
    const x0 = e.clientX
    const y0 = e.clientY
    const move = (ev: PointerEvent) => {
      setScroll(sx - (ev.clientX - x0))
      scroller.scrollTop = sy - (ev.clientY - y0)
    }
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function moveStart(e: PointerEvent, grabbedId: Id, grabbedTrack: Track) {
    const startX = e.clientX
    const startT = timeAt(e.clientX)
    const startRow = rowAt(e.clientY)
    let started = false
    const ids = new Set(app.selection.clips.get())
    if (!ids.size) ids.add(grabbedId)
    const t = tl()
    const clips = [...ids].map((id) => findClip(t, id)).filter(Boolean) as NonNullable<ReturnType<typeof findClip>>[]
    const minStart = Math.min(...clips.map((c) => c.clip.start))
    const sameKind = (k: string) => rows().filter((r) => r.track.kind === k)
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - (e.clientY)) < 3) return
      started = true
      let dt = timeAt(ev.clientX) - startT
      if (minStart + dt < 0) dt = -minStart
      // snap: try every dragged clip's start/end
      let snapAt: Flicks | null = null
      if (snapping() && !ev.altKey) {
        const pts = collectSnapPoints(app, ids, [app.playback.time.get()])
        let bd = snapThreshold()
        let bestDt = dt
        for (const c of clips) {
          for (const edge of [c.clip.start, clipEnd(c.clip)]) {
            for (const p of pts) {
              const d = Math.abs(edge + dt - p)
              if (d <= bd) {
                bd = d
                bestDt = p - edge
                snapAt = p
              }
            }
          }
        }
        dt = bestDt
      } else {
        dt = snapToFrame(minStart + dt, app.fps()) - minStart
      }
      // vertical shift among same-kind tracks (displayed top→bottom)
      let shift = 0
      const cur = rowAt(ev.clientY)
      if (startRow && cur && cur.track.kind === grabbedTrack.kind) {
        const list = sameKind(grabbedTrack.kind)
        shift = list.findIndex((r) => r.track.id === cur.track.id) - list.findIndex((r) => r.track.id === startRow.track.id)
      }
      setDrag({ ids, dt, shift, kind: grabbedTrack.kind, snapAt })
      setSnapLine(snapAt)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
      batch(() => { setDrag(null); setSnapLine(null) })
    }
    const up = () => {
      const d = drag()
      cleanup()
      if (!started || !d || (d.dt === 0 && d.shift === 0)) return
      const moves: MoveRequest[] = []
      for (const c of clips) moves.push({ clipId: c.clip.id, start: Math.max(0, c.clip.start + d.dt), trackId: shiftedTrack(c.track, d) })
      app.edit.moveClips(moves)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    return cleanup
  }

  /** Target track for a clip under a drag's vertical shift (only clips of the grabbed kind move between tracks). */
  const shiftedTrack = (track: Track, d: DragState): Id => {
    if (track.kind !== d.kind || d.shift === 0) return track.id
    const list = rows().filter((r) => r.track.kind === d.kind)
    const i = list.findIndex((r) => r.track.id === track.id)
    const j = Math.max(0, Math.min(list.length - 1, i + d.shift))
    const target = list[j].track
    return target.locked ? track.id : target.id
  }

  function trimStart(e: PointerEvent, id: Id, edge: 'start' | 'end') {
    const f = findClip(tl(), id)
    if (!f) return
    const startT = timeAt(e.clientX)
    const base = edge === 'start' ? f.clip.start : clipEnd(f.clip)
    let phase: 'start' | 'update' = 'start'
    const linked = linkedSelection.get() && !e.altKey
    const move = (ev: PointerEvent) => {
      const raw = base + timeAt(ev.clientX) - startT
      const s = snapTo(raw, new Set(linked ? expandLinked(tl(), [id]) : [id]), ev.altKey)
      setSnapLine(s.at)
      app.edit.trimClip(id, edge, s.t, { gesture: phase, linked })
      phase = 'update'
      const current = findClip(tl(), id)?.clip
      const dt = current ? (edge === 'start' ? current.start : clipEnd(current)) - base : 0
      setToolTip({ text: `${dt < 0 ? '−' : '+'}${formatTimecode(Math.abs(dt), app.fps())}`, x: ev.clientX - root.getBoundingClientRect().left + 12, y: ev.clientY - root.getBoundingClientRect().top + 18 })
    }
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
      setSnapLine(null)
      setToolTip(null)
      if (phase === 'update') app.doc.endGesture()
    }
    const up = (ev: PointerEvent) => {
      if (phase === 'update') {
        const raw = base + timeAt(ev.clientX) - startT
        app.edit.trimClip(id, edge, snapTo(raw, new Set([id]), ev.altKey).t, { gesture: 'end', linked })
      }
      cleanup()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    return cleanup
  }

  function marqueeStart(e: PointerEvent) {
    const r = laneRect()
    const x0 = e.clientX - r.left
    const y0 = e.clientY - r.top
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const base = additive ? app.selection.clips.get() : []
    if (!additive) app.selection.setClips([])
    let moved = false
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - r.left
      const y1 = ev.clientY - r.top
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return
      moved = true
      setMarquee({ x0, y0, x1, y1 })
      const ta = app.view.pxToTime(Math.min(x0, x1) - HEADER_W + app.view.scrollX.get())
      const tb = app.view.pxToTime(Math.max(x0, x1) - HEADER_W + app.view.scrollX.get())
      const ya = Math.min(y0, y1)
      const yb = Math.max(y0, y1)
      const hit: Id[] = []
      for (const row of rows()) {
        if (row.y + row.h < ya || row.y > yb || row.track.locked) continue
        for (const c of clipsInRange(row.track, ta, tb)) hit.push(c.id)
      }
      app.selection.setClips([...new Set([...base, ...hit])])
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      // A plain click on empty lane space moves the playhead there (DaVinci-style).
      if (!moved && !additive) {
        app.playback.pause()
        app.playback.seek(snapToFrame(Math.max(0, timeAt(ev.clientX)), app.fps()))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ───────── ruler scrubbing ─────────
  const onRulerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    app.playback.pause()
    const seek = (ev: PointerEvent) => {
      const r = ruler.getBoundingClientRect()
      let t = app.view.pxToTime(ev.clientX - r.left + app.view.scrollX.get())
      if (snapping() && !ev.altKey && !ev.shiftKey) {
        const s = snapTo(t, new Set(), false)
        t = s.t
      }
      app.playback.seek(Math.max(0, snapping() && !ev.altKey && !ev.shiftKey ? t : snapToFrame(t, app.fps())))
    }
    seek(e)
    const up = () => {
      target.removeEventListener('pointermove', seek)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', seek)
    target.addEventListener('pointerup', up)
  }

  // ───────── wheel: scroll / zoom ─────────
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const anchor = e.clientX - root.getBoundingClientRect().left - HEADER_W
      app.view.zoomAround(Math.exp(-e.deltaY * 0.0025), Math.max(0, anchor))
      return
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX
    if (dx) {
      e.preventDefault()
      setScroll(app.view.scrollX.get() + dx)
    }
  }

  // ───────── drag & drop from Sources / OS ─────────
  const dropKinds = ['application/x-cascade-media', 'application/x-cascade-generator', 'Files']
  const dropHandler = (dt: DataTransfer) => app.registries.timelineDrops.all().find((h) => h.accepts(dt))
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer || !(dropKinds.some((k) => e.dataTransfer!.types.includes(k)) || dropHandler(e.dataTransfer))) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const s = snapTo(Math.max(0, timeAt(e.clientX)), new Set(), e.altKey)
    setDrop({ t: s.t, row: rowAt(e.clientY) })
    setSnapLine(s.at)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!rowsEl.contains(e.relatedTarget as Node)) {
      setDrop(null)
      setSnapLine(null)
    }
  }
  const onDrop = async (e: DragEvent) => {
    const d = drop()
    setDrop(null)
    setSnapLine(null)
    if (!e.dataTransfer || !d) return
    e.preventDefault()
    const trackId = d.row && !d.row.track.locked ? d.row.track.id : undefined
    const opts = { start: d.t, trackId, audioTrackId: d.row?.track.kind === 'audio' ? trackId : undefined }
    // Contributed handlers first; they must read the data synchronously (the browser clears it after the event).
    const handler = dropHandler(e.dataTransfer)
    if (handler) { await handler.drop(app, e.dataTransfer, { start: d.t, trackId, trackKind: d.row?.track.kind }); return }
    const mediaId = e.dataTransfer.getData('application/x-cascade-media')
    const genId = e.dataTransfer.getData('application/x-cascade-generator')
    // A marked range dragged from the source monitor lands as a three-point overwrite at the drop point.
    const range = mediaId ? parseRange(e.dataTransfer.getData(SOURCE_RANGE_MIME)) : null
    if (mediaId && range) app.edit.placeSource('overwrite', mediaId, { ...range, at: d.t, targets: trackId && d.row ? { [d.row.track.kind]: trackId } : undefined })
    else if (mediaId) app.edit.addMediaToTimeline(mediaId, opts)
    else if (genId) {
      const id = app.edit.addGenerated(genId)
      if (id) app.edit.addMediaToTimeline(id, opts)
    } else if (e.dataTransfer.files.length) {
      const fs = app.host?.fs as unknown as { pathForFile?: (f: File) => string }
      const paths = [...e.dataTransfer.files].map((f) => fs.pathForFile?.(f) ?? (f as File & { path?: string }).path).filter(Boolean) as string[]
      const ids = await app.edit.importFiles(paths)
      let start = d.t
      for (const id of ids) {
        app.edit.addMediaToTimeline(id, { ...opts, start })
        start += app.project().media[id]?.meta.duration ?? 5 * FLICKS
      }
    }
  }

  // ───────── context menus ─────────
  const menuItems = (target: 'clip' | 'lane', hit: { track: Track; clipId?: Id; time: Flicks }): PopupMenuItem[] =>
    app.registries.timelineMenus.all().filter((m) => m.target === target).sort((a, b) => (a.order ?? 100) - (b.order ?? 100)).flatMap((m) => m.items(app, hit))
  const clipMenu = (e: MouseEvent, id: Id) => {
    e.preventDefault()
    if (!app.selection.clips.get().includes(id)) selectClip(id, e)
    const f = findClip(tl(), id)
    const contributed = f ? menuItems('clip', { track: f.track, clipId: id, time: timeAt(e.clientX) }) : []
    const items: MenuItem[] = [
      ...(contributed.length ? [...contributed, { separator: true }] : []),
      { label: 'Split at playhead', icon: 'scissors', shortcut: 'S', run: () => app.run('timeline.split') },
      { label: 'Duplicate', icon: 'copy-plus', shortcut: 'Mod+D', run: () => app.run('timeline.duplicate') },
      { separator: true },
      f?.clip.linkId
        ? { label: 'Unlink', icon: 'unlink', run: () => app.run('timeline.unlink') }
        : { label: 'Link selected', icon: 'link', disabled: app.selection.clips.get().length < 2, run: () => app.run('timeline.link') },
      { label: 'Reveal in Sources', icon: 'folder-search', disabled: !f?.clip.mediaId, run: () => (app.selection.media.set([f!.clip.mediaId!]), app.layout.reveal('sources')) },
      { label: 'Show keyframes', icon: 'diamond', run: () => app.layout.activeBottom.set('keyframes') },
      { separator: true },
      { label: 'Delete', icon: 'trash-2', shortcut: 'Delete', run: () => app.run('timeline.delete') },
      { label: 'Ripple delete', icon: 'trash', shortcut: 'Shift+Delete', danger: true, run: () => app.run('timeline.rippleDelete') }
    ]
    for (const m of app.registries.menus.all().filter((m) => m.location === 'clip/context' && (!m.when || m.when(app, id))))
      items.push({ label: m.label, icon: m.icon, shortcut: m.shortcut, disabled: app.registries.commands.get(m.command)?.enabled?.(app) === false, run: () => app.run(m.command, id) })
    openContextMenu(e, items)
  }
  const trackMenu = (e: MouseEvent, track: Track) => {
    e.preventDefault()
    openContextMenu(e, [
      { label: 'Add video track', icon: 'film', run: () => app.edit.addTrack('visual') },
      { label: 'Add audio track', icon: 'audio-lines', run: () => app.edit.addTrack('audio') },
      { separator: true },
      { label: track.locked ? 'Unlock track' : 'Lock track', icon: track.locked ? 'lock-open' : 'lock', run: () => app.edit.updateTrack(track.id, { locked: !track.locked }) },
      { label: 'Reset height', icon: 'move-vertical', run: () => app.edit.updateTrack(track.id, { height: undefined }) },
      { separator: true },
      {
        label: 'Delete track',
        icon: 'trash-2',
        danger: true,
        disabled: tl().tracks.filter((t) => t.kind === track.kind).length <= 1,
        run: async () => {
          if (track.clips.length && (await app.host?.dialog.confirm({ message: `Delete ${track.name} and its ${track.clips.length} clip(s)?`, buttons: ['Cancel', 'Delete'] })) !== 1) return
          app.edit.removeTrack(track.id)
        }
      }
    ])
  }

  // ───────── track resize ─────────
  const resizeStart = (e: PointerEvent, row: Row) => {
    e.preventDefault()
    e.stopPropagation()
    const y0 = e.clientY
    const h0 = row.h
    const move = (ev: PointerEvent) => setResizing({ id: row.track.id, h: Math.max(28, Math.min(220, h0 + ev.clientY - y0)) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const r = resizing()
      setResizing(null)
      if (r) app.edit.updateTrack(r.id, { height: Math.round(r.h) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // hover time for the blade cursor line
  const onLaneMove = (e: PointerEvent) => {
    if (tool() !== 'blade') return hoverT() !== null && setHoverT(null)
    setHoverT(snapTo(Math.max(0, timeAt(e.clientX)), new Set(), e.altKey).t)
  }

  // ghost boxes for a move in progress
  const ghosts = createMemo(() => {
    const d = drag()
    if (!d) return []
    const out: { x: number; w: number; y: number; h: number; color: string }[] = []
    for (const id of d.ids) {
      const f = findClip(tl(), id)
      if (!f) continue
      const row = rows().find((r) => r.track.id === shiftedTrack(f.track, d))
      if (!row) continue
      out.push({ x: x(f.clip.start + d.dt), w: (f.clip.duration / FLICKS) * pps(), y: row.y, h: row.h, color: colorOf(app, f.clip) })
    }
    return out
  })

  return (
    <div class="tl-workspace">
    <TimelineTabs app={app} />
    <div class={`tl tool-${tool()}`} style={{ '--tool-cursor': activeTool()?.cursor ?? 'default' }} ref={root} onWheel={onWheel}>
      <Show when={toolTip()}>{(tip) => <div class="tl-edit-tooltip glass tnum" style={{ left: `${tip().x}px`, top: `${tip().y}px` }}>{tip().text}</div>}</Show>
      <div class="tl-top">
        <div class="tl-corner tnum">
          <TimecodeReadout app={app} />
        </div>
        <div class="tl-ruler-wrap" onPointerDown={onRulerDown}>
          <canvas class="tl-ruler" ref={ruler} />
          <Decorations app={app} target="ruler" geometry={laneGeometry(() => RULER_H)} />
          <div class="tl-playhead-head" ref={playheadHead}>
            <svg width="13" height="16" viewBox="0 0 13 16">
              <path d="M1 1h11v9l-5.5 5L1 10z" />
            </svg>
          </div>
        </div>
      </div>
      <div class="tl-scroll" ref={scroller}>
        <div
          class="tl-rows"
          ref={rowsEl}
          style={{ height: `${totalH()}px` }}
          onPointerDown={onLaneDown}
          onPointerMove={onLaneMove}
          onPointerLeave={() => setHoverT(null)}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
          onContextMenu={(e) => {
            const c = (e.target as HTMLElement).closest<HTMLElement>('.tl-clip')
            if (c) clipMenu(e, c.dataset.id!)
            else {
              const row = rowAt(e.clientY)
              if (!row) return
              const target = { trackId: row.track.id, t: snapToFrame(Math.max(0, timeAt(e.clientX)), app.fps()) }
              app.selection.track.set(row.track.id)
              const items: MenuItem[] = app.registries.menus.all().filter((m) => m.location === 'timeline/context' && (!m.when || m.when(app, target))).map((m) => ({ label: m.label, icon: m.icon, run: () => app.run(m.command, target) }))
              items.push(...menuItems('lane', { track: row.track, time: timeAt(e.clientX) }))
              if (items.length) openContextMenu(e, items)
            }
          }}
        >
          {/* Rows and clips are keyed by id (documents are immutable, so objects change on every edit):
              editing one parameter must not remount tracks, clips or their thumbnails. */}
          <For each={rowIds()}>
            {(id) => {
              const row = () => rowById().get(id)!
              const clips = createMemo(() => (row() ? clipsInRange(row().track, t0(), t1()) : []))
              const clipIds = createMemo(() => clips().map((c) => c.id), [] as Id[], { equals: shallowArrayEqual })
              const clipById = createMemo(() => new Map(clips().map((c) => [c.id, c])))
              return (
                <Show when={row()}>
                  <div class={`tl-row ${targetTrack() === row().track.id ? 'target-track' : ''} kind-${row().track.kind} ${row().track.locked ? 'locked' : ''} ${row().track.hidden || row().track.muted ? 'off' : ''}`} style={{ top: `${row().y}px`, height: `${row().h}px` }}>
                    <TrackHeader app={app} row={row()} onMenu={(e) => trackMenu(e, row().track)} onResize={(e) => resizeStart(e, row())} />
                    <div class="tl-lane">
                      <For each={clipIds()}>
                        {(cid) => (
                          <Show when={clipById().get(cid)}>
                            <ClipView
                              app={app}
                              clip={clipById().get(cid)!}
                              track={row().track}
                              h={row().h}
                              x={x}
                              pps={pps()}
                              width={width()}
                              selected={selSet().has(cid)}
                              primary={selected()[selected().length - 1] === cid}
                              dragging={!!drag()?.ids.has(cid)}
                              deco={decoBase}
                            />
                          </Show>
                        )}
                      </For>
                      <Decorations app={app} target="track" geometry={laneGeometry(() => rowById().get(id)?.h ?? row().h, () => rowById().get(id)?.track ?? null)} subject={() => ({ track: row().track })} />
                    </div>
                  </div>
                </Show>
              )
            }}
          </For>
          <div class="tl-divider" style={{ top: `${(rows().find((r) => r.track.kind === 'audio')?.y ?? 0) - 6}px` }} />
          <div class="tl-overlay" style={{ left: `${HEADER_W}px` }}>
            <For each={ghosts()}>{(g) => <div class="tl-ghost" style={{ left: `${g.x}px`, width: `${g.w}px`, top: `${g.y + 2}px`, height: `${g.h - 4}px`, '--c': g.color }} />}</For>
            <Show when={snapLine() !== null}>
              <div class="tl-snapline" style={{ left: `${x(snapLine()!)}px` }} />
            </Show>
            <Show when={hoverT() !== null}>
              <div class="tl-bladeline" style={{ left: `${x(hoverT()!)}px` }} />
            </Show>
            <Show when={drop()}>
              {(d) => (
                <div class="tl-dropmark" style={{ left: `${x(d().t)}px`, top: `${d().row?.y ?? 0}px`, height: `${d().row?.h ?? totalH()}px` }}>
                  <span class="tnum">{formatTimecode(d().t, app.fps())}</span>
                </div>
              )}
            </Show>
          </div>
          <Show when={marquee()}>
            {(m) => (
              <div
                class="tl-marquee"
                style={{ left: `${Math.min(m().x0, m().x1)}px`, top: `${Math.min(m().y0, m().y1)}px`, width: `${Math.abs(m().x1 - m().x0)}px`, height: `${Math.abs(m().y1 - m().y0)}px` }}
              />
            )}
          </Show>
          <Show when={rows().every((r) => r.track.clips.length === 0)}>
            <div class="tl-empty" style={{ left: `${HEADER_W}px` }}>
              <Icon name="mouse-pointer-2" size={16} />
              Drag media from Sources, or double-click it, to start editing
            </div>
          </Show>
        </div>
      </div>
      <div class="tl-playhead" ref={playhead} style={{ left: `${HEADER_W}px` }} />
      <HScrollbar app={app} width={width()} content={contentW() + width() * 0.5} onScroll={setScroll} />
    </div>
    </div>
  )
}

const colorOf = (app: CascadeAPI, clip: Clip) => clip.color ?? app.registries.mediaTypes.get(clip.type)?.color ?? '#888'

function TimecodeReadout(props: { app: CascadeAPI }) {
  const t = useValue(props.app.playback.time)
  const project = useProject(props.app)
  return (
    <span class="tl-tc" data-tip="Playhead">
      {formatTimecode(t(), project().settings.fps)}
    </span>
  )
}

/** The marked source range in a drag, if any. */
function parseRange(json: string): { sourceIn?: Flicks; sourceOut?: Flicks; lanes?: { visual?: boolean; audio?: boolean } } | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function TrackHeader(props: { app: CascadeAPI; row: Row; onMenu: (e: MouseEvent) => void; onResize: (e: PointerEvent) => void }) {
  const app = props.app
  const [editing, setEditing] = createSignal(false)
  const t = () => props.row.track
  const project = useProject(app)
  const targets = useValue(app.selection.targets)
  // The track source edits land on for this kind: the picked one, else the first unlocked.
  const isTarget = () => resolveTarget(project().timelines[project().activeTimeline], t().kind, targets()[t().kind])?.id === t().id
  return (
    <div class="tl-head" onContextMenu={props.onMenu} onPointerDown={(e) => { e.stopPropagation(); app.selection.track.set(t().id) }}>
      <span class={`tl-badge kind-${t().kind}`}>{t().name}</span>
      <Show
        when={editing()}
        fallback={
          <span class="tl-head-name" onDblClick={() => setEditing(true)}>
            {t().kind === 'visual' ? 'Video' : 'Audio'}
          </span>
        }
      >
        <input
          class="tl-head-input"
          value={t().name}
          ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim()
            if (v && v !== t().name) app.edit.updateTrack(t().id, { name: v })
            setEditing(false)
          }}
        />
      </Show>
      <div class="tl-head-btns">
        <button class={`tl-target${isTarget() ? ' on' : ''}`} data-tip={isTarget() ? 'Target track for insert / overwrite' : 'Target this track for insert / overwrite'} onClick={() => app.selection.targets.set({ ...targets(), [t().kind]: t().id })}>
          <Icon name="target" size={13} />
        </button>
        <Show
          when={t().kind === 'visual'}
          fallback={
            <>
              <button class={t().muted ? 'on warn' : ''} data-tip={t().muted ? 'Unmute' : 'Mute'} onClick={() => app.edit.updateTrack(t().id, { muted: !t().muted })}>
                <Icon name={t().muted ? 'volume-x' : 'volume-2'} size={13} />
              </button>
              <button class={`tl-solo${t().solo ? ' on' : ''}`} data-tip={t().solo ? 'Unsolo' : 'Solo'} onClick={() => app.edit.updateTrack(t().id, { solo: !t().solo })}>
                S
              </button>
            </>
          }
        >
          <button class={t().hidden ? 'on warn' : ''} data-tip={t().hidden ? 'Show track' : 'Hide track'} onClick={() => app.edit.updateTrack(t().id, { hidden: !t().hidden })}>
            <Icon name={t().hidden ? 'eye-off' : 'eye'} size={13} />
          </button>
        </Show>
        <button class={t().locked ? 'on' : ''} data-tip={t().locked ? 'Unlock' : 'Lock'} onClick={() => app.edit.updateTrack(t().id, { locked: !t().locked })}>
          <Icon name={t().locked ? 'lock' : 'lock-open'} size={13} />
        </button>
      </div>
      <div class="tl-head-resize" onPointerDown={props.onResize} />
    </div>
  )
}

function ClipView(props: {
  app: CascadeAPI
  clip: Clip
  track: Track
  h: number
  x: (t: Flicks) => number
  pps: number
  width: number
  selected: boolean
  primary: boolean
  dragging: boolean
  /** Shared decoration helpers (snapping, snap guide); geometry is per clip. */
  deco: Pick<TimelineDecorationContext, 'timeAt' | 'snap' | 'showSnapGuide'>
}) {
  const app = props.app
  const doc = useProject(app)
  // "2×", or the range of a keyframed speed ("0.5–3×"); "◀" when reversed. Reads the project: a linked partner may own the speed.
  const speedLabel = createMemo(() => {
    doc()
    const map = app.edit.timeMap(props.clip)
    const fmt = (v: number) => `${+v.toFixed(2)}`
    const back = map.reversed ? '◀' : ''
    if (map.constant !== null) return Math.abs(map.constant - 1) > 1e-6 ? `${back}${fmt(map.constant)}×` : back
    const [lo, hi] = [map.min, map.max]
    return back + (fmt(lo) === fmt(hi) ? `${fmt(lo)}×` : `${fmt(lo)}–${fmt(hi)}×`)
  })
  const mt = () => app.registries.mediaTypes.get(props.clip.type)
  // Clamp the element to the visible window so hour-long clips stay cheap at any zoom.
  const geo = createMemo(() => {
    const sx = props.x(props.clip.start)
    const ex = props.x(clipEnd(props.clip))
    const l = Math.max(sx, -400)
    const r = Math.min(ex, props.width + 400)
    return { left: l, width: Math.max(1, r - l), offset: sx - l, full: ex - sx }
  })
  const kfs = createMemo(() => clipKeyframeTimes(props.clip))
  const tiny = () => geo().full < 28
  const changes = new Emitter<void>()
  createEffect(on([() => props.clip, () => props.pps, geo, () => props.h], () => changes.emit()))

  const body = (el: HTMLElement) => {
    const m = mt()
    if (!m?.clipBody) return
    const isVisual = m.track === 'visual'
    if (isVisual && app.settings.get<boolean>('timeline.thumbnails') === false) return
    if (!isVisual && app.settings.get<boolean>('timeline.waveforms') === false) return
    const ctx: ClipBodyContext = {
      app,
      clip: () => props.clip,
      media: () => (props.clip.mediaId ? app.project().media[props.clip.mediaId] : undefined),
      view: () => {
        const g = geo()
        const visStartPx = Math.max(0, -g.offset)
        return {
          pxPerSecond: props.pps,
          visibleStart: Math.round(((visStartPx) / props.pps) * FLICKS),
          visibleEnd: Math.round(((visStartPx + g.width) / props.pps) * FLICKS),
          height: Math.max(8, props.h - 22)
        }
      },
      subscribe: (fn) => {
        const d = changes.on(fn)
        return () => d.dispose()
      }
    }
    return m.clipBody(el, ctx)
  }

  return (
    <div
      class={`tl-clip ${props.selected ? 'sel' : ''} ${props.primary ? 'primary' : ''} ${props.dragging ? 'dragging' : ''} ${tiny() ? 'tiny' : ''} type-${mt()?.track ?? 'visual'}`}
      onDblClick={() => mt()?.open?.(app, props.clip)}
      data-id={props.clip.id}
      style={{ left: `${geo().left}px`, width: `${geo().width}px`, '--c': colorOf(app, props.clip) }}
    >
      <div class="tl-clip-label" style={{ 'padding-left': `${Math.max(6, -geo().left + 6)}px` }}>
        <Show when={props.clip.linkId}>
          <Icon name="link-2" size={10} class="tl-clip-link" />
        </Show>
        <span class="tl-clip-name">{props.clip.name}</span>
        <Show when={speedLabel()}>
          <span class="tl-clip-speed tnum">{speedLabel()}</span>
        </Show>
      </div>
      <div class="tl-clip-body">
        <div class="tl-clip-body-inner" style={{ left: `${geo().offset}px`, width: `${geo().full}px` }}>
          <Show when={mt()} keyed>
            {(_m) => <BodyMount mount={body} />}
          </Show>
        </div>
      </div>
      <Show when={kfs().length && !tiny()}>
        <div class="tl-clip-kfs">
          <For each={kfs()}>{(t) => <i style={{ left: `${geo().offset + (t / FLICKS) * props.pps}px` }} />}</For>
        </div>
      </Show>
      <Decorations app={app} target="clip" subject={() => ({ track: props.track, clip: props.clip })} geometry={{
        ...props.deco,
        x: (t) => props.x(t) - geo().left, width: () => geo().width, height: () => props.h,
        timeAt: (px) => props.deco.timeAt(px + geo().left),
        range: () => ({ start: props.deco.timeAt(geo().left), end: props.deco.timeAt(geo().left + geo().width) }),
        track: () => props.track, clip: () => props.clip,
        subscribe: (fn) => { const d = changes.on(fn); return () => d.dispose() }
      }} />
      <div class="tl-edge start" data-edge="start" />
      <div class="tl-edge end" data-edge="end" />
    </div>
  )
}

function BodyMount(props: { mount: (el: HTMLElement) => void | (() => void) }) {
  let el!: HTMLDivElement
  onMount(() => {
    const c = props.mount(el)
    onCleanup(() => c?.())
  })
  return <div class="tl-body-mount" ref={el} />
}

function HScrollbar(props: { app: CascadeAPI; width: number; content: number; onScroll: (v: number) => void }) {
  const scrollX = useValue(props.app.view.scrollX)
  const ratio = () => Math.min(1, props.width / Math.max(1, props.content))
  const thumbW = () => Math.max(30, props.width * ratio())
  const thumbX = () => (props.content <= props.width ? 0 : (scrollX() / (props.content - props.width)) * (props.width - thumbW()))
  const down = (e: PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const s0 = scrollX()
    const k = (props.content - props.width) / Math.max(1, props.width - thumbW())
    const move = (ev: PointerEvent) => props.onScroll(s0 + (ev.clientX - x0) * k)
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div class="tl-hscroll" style={{ left: `${HEADER_W}px` }}>
      <Show when={ratio() < 1}>
        <div class="tl-hscroll-thumb" style={{ width: `${thumbW()}px`, transform: `translateX(${thumbX()}px)` }} onPointerDown={down} />
      </Show>
    </div>
  )
}
