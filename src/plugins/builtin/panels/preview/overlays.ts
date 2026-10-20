import type { CascadeAPI } from '@core/app'
import type { OverlayContribution, OverlayContext } from '@core/plugin-api'
import { findClip, type Id } from '@shared/project'
import type { PreviewEngine } from './engine'

type Pt = { x: number; y: number }
const SVG = 'http://www.w3.org/2000/svg'
const SNAP_PX = 7

/** Corners of a stage element (in display px), honoring its full CSS transform (incl. 3D). */
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
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h]
  ].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x - ox, y - oy))
    return { x: (el.offsetLeft + ox + p.x / p.w) / q, y: (el.offsetTop + oy + p.y / p.w) / q }
  })
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** Move / scale / rotate the selected clip directly on the preview. Edits the Transform property. */
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
    let dragging = false

    const target = (): { clipId: Id; el: HTMLElement } | null => {
      const id = app.selection.primaryClip
      if (!id) return null
      const f = findClip(app.timeline(), id)
      if (!f || f.track.kind !== 'visual' || f.track.locked) return null
      const e = ctx.clipElement(id)
      return e ? { clipId: id, el: e } : null
    }

    const draw = () => {
      const t = target()
      const eng = engine()
      svg.replaceChildren()
      if (!t || !eng) return
      const c = corners(t.el, eng)
      if (!c) return
      const poly = document.createElementNS(SVG, 'polygon')
      poly.setAttribute('points', c.map((p) => `${p.x},${p.y}`).join(' '))
      poly.classList.add('gz-box')
      poly.addEventListener('pointerdown', (e) => startDrag(e, 'move', t.clipId, c))
      svg.appendChild(poly)
      const top = mid(c[0], c[1])
      const center = mid(c[0], c[2])
      const away = { x: top.x - center.x, y: top.y - center.y }
      const len = Math.hypot(away.x, away.y) || 1
      const rot = { x: top.x + (away.x / len) * 22, y: top.y + (away.y / len) * 22 }
      const stem = document.createElementNS(SVG, 'line')
      stem.setAttribute('x1', String(top.x))
      stem.setAttribute('y1', String(top.y))
      stem.setAttribute('x2', String(rot.x))
      stem.setAttribute('y2', String(rot.y))
      stem.classList.add('gz-stem')
      svg.appendChild(stem)
      const rh = document.createElementNS(SVG, 'circle')
      rh.setAttribute('cx', String(rot.x))
      rh.setAttribute('cy', String(rot.y))
      rh.setAttribute('r', '5')
      rh.classList.add('gz-rot')
      rh.addEventListener('pointerdown', (e) => startDrag(e, 'rotate', t.clipId, c))
      svg.appendChild(rh)
      for (const p of c) {
        const h = document.createElementNS(SVG, 'rect')
        h.setAttribute('x', String(p.x - 4.5))
        h.setAttribute('y', String(p.y - 4.5))
        h.setAttribute('width', '9')
        h.setAttribute('height', '9')
        h.setAttribute('rx', '2')
        h.classList.add('gz-handle')
        h.addEventListener('pointerdown', (e) => startDrag(e, 'scale', t.clipId, c))
        svg.appendChild(h)
      }
    }

    const guides = (x: boolean, y: boolean) => {
      svg.querySelectorAll('.gz-guide').forEach((g) => g.remove())
      const r = ctx.frameRect()
      const line = (x1: number, y1: number, x2: number, y2: number) => {
        const l = document.createElementNS(SVG, 'line')
        l.setAttribute('x1', String(x1))
        l.setAttribute('y1', String(y1))
        l.setAttribute('x2', String(x2))
        l.setAttribute('y2', String(y2))
        l.classList.add('gz-guide')
        svg.appendChild(l)
      }
      if (x) line(r.width / 2, 0, r.width / 2, r.height)
      if (y) line(0, r.height / 2, r.width, r.height / 2)
    }

    function startDrag(e: PointerEvent, mode: 'move' | 'scale' | 'rotate', clipId: Id, c: Pt[]) {
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
      const rot0 = Number(app.edit.paramValue(clipId, propId, 'rotation') ?? 0)
      const pivot = mid(c[0], c[2])
      const fr = ctx.frameRect()
      let phase: 'start' | 'update' = 'start'
      dragging = true
      const target = e.currentTarget as SVGElement
      target.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const p = local(ev)
        if (mode === 'move') {
          let dx = p.x - start.x
          let dy = p.y - start.y
          if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
          let nx = pos0[0] + dx / fr.width
          let ny = pos0[1] + dy / fr.height
          // Snap the clip's center to the frame center.
          const cx = pivot.x + dx - fr.width / 2
          const cy = pivot.y + dy - fr.height / 2
          const sx = !ev.altKey && Math.abs(cx) < SNAP_PX
          const sy = !ev.altKey && Math.abs(cy) < SNAP_PX
          if (sx) nx -= cx / fr.width
          if (sy) ny -= cy / fr.height
          guides(sx, sy)
          app.edit.setParam(clipId, propId, 'position', [nx, ny], { gesture: phase })
        } else if (mode === 'scale') {
          const k = dist(pivot, p) / Math.max(1, dist(pivot, start))
          let s = scale0 * k
          if (ev.shiftKey) s = Math.round(s * 20) / 20
          app.edit.setParam(clipId, propId, 'scale', Math.max(0.001, s), { gesture: phase })
        } else {
          const a0 = Math.atan2(start.y - pivot.y, start.x - pivot.x)
          const a1 = Math.atan2(p.y - pivot.y, p.x - pivot.x)
          let r = rot0 + ((a1 - a0) * 180) / Math.PI
          if (ev.shiftKey) r = Math.round(r / 15) * 15
          app.edit.setParam(clipId, propId, 'rotation', r, { gesture: phase })
        }
        phase = 'update'
      }
      const up = (ev: PointerEvent) => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        dragging = false
        guides(false, false)
        if (phase === 'update') {
          const v = mode === 'move' ? 'position' : mode
          app.edit.setParam(clipId, propId, v, app.edit.paramValue(clipId, propId, v), { gesture: 'end' })
        }
        void ev
        draw()
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
    }

    const offFrame = ctx.onFrame(() => !dragging && draw())
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
