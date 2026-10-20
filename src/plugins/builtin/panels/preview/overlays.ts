import type { CascadeAPI } from '@core/app'
import type { OverlayContribution, OverlayContext } from '@core/plugin-api'
import { findClip, type Id } from '@shared/project'
import type { PreviewEngine } from './engine'

type Pt = { x: number; y: number }
const SVG = 'http://www.w3.org/2000/svg'
const SNAP_PX = 7

/**
 * Corners of a stage element (in display px), honoring its full CSS transform (incl. 3D). Layout
 * offsets are whole pixels, so the result is re-aligned to the element's sub-pixel bounding box.
 */
function corners(el: HTMLElement, engine: PreviewEngine): Pt[] | null {
  const win = el.ownerDocument.defaultView
  if (!win) return null
  const cs = win.getComputedStyle(el)
  const w = el.offsetWidth
  const h = el.offsetHeight
  if (!w && !h) return null
  const m = cs.transform && cs.transform !== 'none' ? new DOMMatrix(cs.transform) : new DOMMatrix()
  const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat)
  const q = engine.quality.get()
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h]
  ].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x - ox, y - oy))
    return { x: ox + p.x / p.w, y: oy + p.y / p.w }
  })
  const minX = Math.min(...pts.map((p) => p.x))
  const minY = Math.min(...pts.map((p) => p.y))
  const bw = Math.max(...pts.map((p) => p.x)) - minX
  const bh = Math.max(...pts.map((p) => p.y)) - minY
  const r = el.getBoundingClientRect()
  const kx = bw > 0.5 ? r.width / bw : 1
  const ky = bh > 0.5 ? r.height / bh : 1
  return pts.map((p) => ({ x: (r.left + (p.x - minX) * kx) / q, y: (r.top + (p.y - minY) * ky) / q }))
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y
const norm = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}

/** Box geometry from its corners (TL, TR, BR, BL): local axes, size, and a local→display mapper. */
function frameOf(c: Pt[]) {
  const ux = norm(sub(c[1], c[0]))
  const uy = norm(sub(c[3], c[0]))
  const w = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y)
  const h = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y)
  // Bilinear, so it is exact for affine boxes and close for perspective ones.
  const at = (u: number, v: number): Pt => {
    const top = { x: c[0].x + (c[1].x - c[0].x) * u, y: c[0].y + (c[1].y - c[0].y) * u }
    const bot = { x: c[3].x + (c[2].x - c[3].x) * u, y: c[3].y + (c[2].y - c[3].y) * u }
    return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v }
  }
  return { ux, uy, w, h, at }
}

/** Handles in box-local units: corners scale, edge midpoints stretch one axis. */
const HANDLES: { u: number; v: number }[] = [
  { u: 0, v: 0 },
  { u: 0.5, v: 0 },
  { u: 1, v: 0 },
  { u: 1, v: 0.5 },
  { u: 1, v: 1 },
  { u: 0.5, v: 1 },
  { u: 0, v: 1 },
  { u: 0, v: 0.5 }
]
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']
/** Resize cursor for a direction on screen (any rotation). */
const cursorFor = (d: Pt) => {
  const a = ((Math.atan2(d.y, d.x) * 180) / Math.PI + 180 + 22.5) % 180
  return CURSORS[Math.floor(a / 45) % 4]
}

/** Nearest snap of any of `values` to any of `lines` within `tol`: the correction and the line hit. */
function snap1(values: number[], lines: number[], tol: number): { d: number; line: number } | null {
  let best: { d: number; line: number } | null = null
  for (const v of values)
    for (const l of lines) {
      const d = l - v
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: l }
    }
  return best
}

type Mode = { kind: 'move' } | { kind: 'rotate' } | { kind: 'scale'; u: number; v: number }

/**
 * Move / scale / stretch / rotate the selected clip directly on the preview. Edits the Transform
 * property. Corners scale from the opposite corner (Alt: from the center, Shift: free aspect),
 * edges stretch from the opposite edge, and the box snaps to the frame's edges and center.
 */
export const transformOverlay: OverlayContribution = {
  id: 'transform',
  name: 'Transform handles',
  defaultEnabled: true,
  mount(el, ctx) {
    const app = ctx.app
    const engine = () => app.services.get('preview') as PreviewEngine | undefined
    const svg = document.createElementNS(SVG, 'svg')
    svg.classList.add('gz')
    el.appendChild(svg)
    let snapLines: { x: number[]; y: number[] } = { x: [], y: [] }

    const target = (): { clipId: Id; el: HTMLElement } | null => {
      const id = app.selection.primaryClip
      if (!id) return null
      const f = findClip(app.timeline(), id)
      if (!f || f.track.kind !== 'visual' || f.track.locked) return null
      const e = ctx.clipElement(id)
      return e ? { clipId: id, el: e } : null
    }

    const node = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, cls: string) => {
      const n = document.createElementNS(SVG, tag)
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
      n.classList.add(cls)
      svg.appendChild(n)
      return n
    }

    // Redrawn every stage frame, including mid-drag, so the handles track the box live.
    const draw = () => {
      const t = target()
      const eng = engine()
      svg.replaceChildren()
      const r = ctx.frameRect()
      for (const x of snapLines.x) node('line', { x1: x, y1: 0, x2: x, y2: r.height }, 'gz-guide')
      for (const y of snapLines.y) node('line', { x1: 0, y1: y, x2: r.width, y2: y }, 'gz-guide')
      if (!t || !eng) return
      const c = corners(t.el, eng)
      if (!c) return
      const g = frameOf(c)
      const poly = node('polygon', { points: c.map((p) => `${p.x},${p.y}`).join(' ') }, 'gz-box')
      poly.addEventListener('pointerdown', (e) => startDrag(e, { kind: 'move' }, t.clipId, c))
      const top = g.at(0.5, 0)
      const away = { x: -g.uy.x, y: -g.uy.y }
      const rot = { x: top.x + away.x * 22, y: top.y + away.y * 22 }
      node('line', { x1: top.x, y1: top.y, x2: rot.x, y2: rot.y }, 'gz-stem')
      const rh = node('circle', { cx: rot.x, cy: rot.y, r: 5 }, 'gz-rot')
      rh.addEventListener('pointerdown', (e) => startDrag(e, { kind: 'rotate' }, t.clipId, c))
      for (const hd of HANDLES) {
        const p = g.at(hd.u, hd.v)
        const edge = hd.u === 0.5 || hd.v === 0.5
        const h = node('rect', edge ? { x: p.x - 3.5, y: p.y - 3.5, width: 7, height: 7, rx: 1.5 } : { x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9, rx: 2 }, 'gz-handle')
        h.style.cursor = cursorFor(sub(p, g.at(0.5, 0.5)))
        h.addEventListener('pointerdown', (e) => startDrag(e, { kind: 'scale', u: hd.u, v: hd.v }, t.clipId, c))
      }
    }

    function startDrag(e: PointerEvent, mode: Mode, clipId: Id, c: Pt[]) {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const propId = ensureTransform(app, clipId)
      if (!propId) return
      const rect = el.getBoundingClientRect()
      const local = (ev: PointerEvent): Pt => ({ x: ev.clientX - rect.left, y: ev.clientY - rect.top })
      const start = local(e)
      const pos0 = (app.edit.paramValue(clipId, propId, 'position') as [number, number]) ?? [0, 0]
      const scale0 = Number(app.edit.paramValue(clipId, propId, 'scale') ?? 1)
      const stretch0 = (app.edit.paramValue(clipId, propId, 'stretch') as [number, number] | undefined) ?? [1, 1]
      const rot0 = Number(app.edit.paramValue(clipId, propId, 'rotation') ?? 0)
      const anchor = (app.edit.paramValue(clipId, propId, 'anchor') as [number, number] | undefined) ?? [0.5, 0.5]
      const g = frameOf(c)
      const center = g.at(0.5, 0.5)
      const A = g.at(anchor[0], anchor[1]) // where the anchor (position + pivot) sits on screen
      const fr = ctx.frameRect()
      const lines = { x: [0, fr.width / 2, fr.width], y: [0, fr.height / 2, fr.height] }
      const xs = c.map((p) => p.x).concat(center.x)
      const ys = c.map((p) => p.y).concat(center.y)
      const refW = app.project().settings.width
      const refH = app.project().settings.height
      // Snapped values land on whole reference pixels, so "centered" reads exactly 0, 0.
      const toPos = (dx: number, dy: number, snapX: boolean, snapY: boolean): [number, number] => {
        let x = pos0[0] + dx / fr.width
        let y = pos0[1] + dy / fr.height
        if (snapX) x = Math.round(x * refW) / refW
        if (snapY) y = Math.round(y * refH) / refH
        return [x, y]
      }
      // Boxes with their own Size (shapes, text boxes) resize instead of stretching, so corners stay crisp.
      const sizeProp = findClip(app.timeline(), clipId)?.clip.properties.find((x) => x.type === 'size')
      const size0 = sizeProp ? ((app.edit.paramValue(clipId, sizeProp.id, 'size') as [number, number] | undefined) ?? null) : null
      let phase: 'start' | 'update' = 'start'
      let last: Record<Id, Record<string, unknown>> = {}
      const set = (values: Record<string, unknown>) => {
        const { size, ...rest } = values
        last = { [propId]: rest, ...(size && sizeProp ? { [sizeProp.id]: { size } } : {}) }
        app.edit.setClipParams(clipId, last, { gesture: phase })
      }

      const move = (ev: PointerEvent) => {
        const p = local(ev)
        const snapOn = !ev.altKey && app.view.snapping.get()
        let lx: number[] = []
        let ly: number[] = []
        if (mode.kind === 'move') {
          let dx = p.x - start.x
          let dy = p.y - start.y
          if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
          const sx = snapOn ? snap1(xs.map((x) => x + dx), lines.x, SNAP_PX) : null
          const sy = snapOn ? snap1(ys.map((y) => y + dy), lines.y, SNAP_PX) : null
          if (sx) (dx += sx.d), (lx = [sx.line])
          if (sy) (dy += sy.d), (ly = [sy.line])
          set({ position: toPos(dx, dy, !!sx, !!sy) })
        } else if (mode.kind === 'scale') {
          const corner = mode.u !== 0.5 && mode.v !== 0.5
          // Fixed point: the opposite corner/edge, or the center with Alt.
          const fu = ev.altKey ? 0.5 : 1 - mode.u
          const fv = ev.altKey ? 0.5 : 1 - mode.v
          const F = g.at(fu, fv)
          let q = p
          const sx = snapOn && mode.u !== 0.5 ? snap1([p.x], lines.x, SNAP_PX) : null
          const sy = snapOn && mode.v !== 0.5 ? snap1([p.y], lines.y, SNAP_PX) : null
          if (sx || sy) q = { x: p.x + (sx?.d ?? 0), y: p.y + (sy?.d ?? 0) }
          const hu = (mode.u - fu) * g.w
          const hv = (mode.v - fv) * g.h
          const d = sub(q, F)
          let kx = hu ? dot(d, g.ux) / hu : 1
          let ky = hv ? dot(d, g.uy) / hv : 1
          let showX = !!sx
          let showY = !!sy
          if (corner && !ev.shiftKey) {
            // Uniform: follow the snapped axis (both: the one that fits inside), else project onto the diagonal.
            const diag = { x: g.ux.x * hu + g.uy.x * hv, y: g.ux.y * hu + g.uy.y * hv }
            const k = sx && sy ? Math.min(kx, ky) : sx ? kx : sy ? ky : dot(sub(p, F), diag) / Math.max(1e-6, dot(diag, diag))
            if (sx && sy) (showX = k === kx), (showY = k === ky)
            kx = ky = k
          }
          kx = Math.max(0.001, kx)
          ky = Math.max(0.001, ky)
          if (sx && showX) lx = [sx.line]
          if (sy && showY) ly = [sy.line]
          // Keep F fixed: the anchor moves with the box around it.
          const fa = sub(F, A)
          const ax = dot(fa, g.ux)
          const ay = dot(fa, g.uy)
          const A2 = { x: F.x - g.ux.x * ax * kx - g.uy.x * ay * ky, y: F.y - g.ux.y * ax * kx - g.uy.y * ay * ky }
          const position = toPos(A2.x - A.x, A2.y - A.y, false, false)
          if (corner && !ev.shiftKey) set({ scale: Math.max(0.001, scale0 * kx), position })
          else if (size0) set({ size: [size0[0] * kx, size0[1] * ky], position })
          else set({ stretch: [stretch0[0] * kx, stretch0[1] * ky], position })
        } else {
          const a0 = Math.atan2(start.y - A.y, start.x - A.x)
          const a1 = Math.atan2(p.y - A.y, p.x - A.x)
          let r = rot0 + ((a1 - a0) * 180) / Math.PI
          if (ev.shiftKey) r = Math.round(r / 15) * 15
          set({ rotation: r })
        }
        snapLines = { x: lx, y: ly }
        phase = 'update'
        if (!lx.length && !ly.length) svg.querySelectorAll('.gz-guide').forEach((n) => n.remove())
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        snapLines = { x: [], y: [] }
        if (phase === 'update') app.edit.setClipParams(clipId, last, { gesture: 'end' })
        draw()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

    const offFrame = ctx.onFrame(draw)
    const offSel = app.selection.clips.subscribe(draw)
    draw()
    return () => {
      offFrame()
      offSel.dispose()
      svg.remove()
    }
  }
}

function ensureTransform(app: CascadeAPI, clipId: Id): Id | null {
  const f = findClip(app.timeline(), clipId)
  if (!f) return null
  const p = f.clip.properties.find((x) => x.type === 'transform')
  return p ? p.id : app.edit.addProperty(clipId, 'transform')
}

/** Title/action safe areas and center cross. */
export const safeAreasOverlay: OverlayContribution = {
  id: 'safe-areas',
  name: 'Safe areas',
  defaultEnabled: false,
  mount(el: HTMLElement, _ctx: OverlayContext) {
    const d = document.createElement('div')
    d.className = 'safe-areas'
    d.innerHTML = '<div class="sa-action"></div><div class="sa-title"></div><div class="sa-cross"></div>'
    el.appendChild(d)
    return () => d.remove()
  }
}
