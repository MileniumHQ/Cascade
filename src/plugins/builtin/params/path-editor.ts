import { definePlugin, type OverlayContribution, type PluginContext } from '@core/plugin-api'
import { clonePath, cubicPoint, hitPathSegment, insertPathPoint, pathSegment, segmentCount, togglePathSmooth, type PathValue, type Point } from '@shared/path'
import { quadMapping } from '@shared/path-space'
import { PATH_EDITOR_OVERLAY, selectedPath } from './path-target'
import './path-editor.css'

const SVG = 'http://www.w3.org/2000/svg'
const SERVICE = 'cascade.path.editor'
interface PathEditorActions { focus(): void; remove(): void; deselect(): void; hasPoint(): boolean }
/** Path handles on the preview for any param type declaring `directEdit: 'path-editor'`. Editor only. */
export const pathEditorPlugin = definePlugin({ id: 'cascade.params.path-editor', name: 'Path editing', dependsOn: ['cascade.params'], activate: registerPathEditing })
function registerPathEditing(ctx: PluginContext) {
  const editor = () => ctx.app.services.get(SERVICE) as PathEditorActions | undefined
  ctx.overlays.register(pathOverlay)
  ctx.commands.register({ id: 'path.edit', title: 'Edit path on preview', category: 'Path', enabled: app => !!selectedPath(app), run: () => editor()?.focus() })
  ctx.commands.register({ id: 'path.deletePoint', title: 'Delete path point', category: 'Path', enabled: () => !!editor()?.hasPoint(), run: () => editor()?.remove() })
  ctx.commands.register({ id: 'path.deselectPoint', title: 'Deselect path point', category: 'Path', run: () => editor()?.deselect() })
  for (const key of ['Delete', 'Backspace']) ctx.keybindings.register({ id: `path.delete:${key}`, key, when: 'path-editor', command: 'path.deletePoint' })
  ctx.keybindings.register({ id: 'path.escape', key: 'Escape', when: 'path-editor', command: 'path.deselectPoint' })
  ctx.menus.register({ id: 'menu:path.delete', location: 'app/edit', group: 'path', label: 'Delete path point', command: 'path.deletePoint', when: () => !!editor()?.hasPoint() })
}
export const pathOverlay: OverlayContribution = {
  id: PATH_EDITOR_OVERLAY, name: 'Path handles', defaultEnabled: true,
  mount(el, ctx) {
    const app = ctx.app, svg = document.createElementNS(SVG, 'svg')
    svg.classList.add('path-overlay'); svg.setAttribute('tabindex', '0'); svg.dataset.panel = 'path-editor'
    svg.setAttribute('aria-label', 'Path editor'); el.append(svg)
    let lastClick: { index: number; at: number; point: Point } | undefined
    let selected: number | null = null, identity = '', finish: (() => void) | undefined, release: (() => void) | undefined
    const node = (tag: string, attrs: Record<string, string | number>, cls: string) => {
      const n = document.createElementNS(SVG, tag)
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
      n.setAttribute('class', cls); svg.append(n); return n
    }
    const set = (t: NonNullable<ReturnType<typeof selectedPath>>, value: PathValue, gesture?: 'start' | 'update' | 'end', at?: number) => app.edit.setParam(t.clipId, t.propertyId, t.paramId, value, { gesture, at })
    const localEvent = (e: MouseEvent): Point => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const draw = () => {
      const t = selectedPath(app)
      // While a path is the edit target the transform gizmo yields (pointer and Delete/Escape belong to the path).
      if (t && !release) release = ctx.claimInput()
      else if (!t && release) { release(); release = undefined }
      const id = t ? `${t.clipId}:${t.propertyId}:${t.paramId}` : ''
      if (id !== identity) { finish?.(); identity = id; selected = null; lastClick = undefined }
      svg.replaceChildren()
      if (!t) return
      const quad = ctx.clipCorners(t.clipId), map = quad && quadMapping(quad)
      if (!map) return
      const value = t.value, screen = map.toScreen
      if (selected !== null && selected >= value.points.length) selected = null
      // Sample the cubic before projection: perspective maps a cubic to a rational curve.
      let data = ''
      if (value.points.length) { const p = screen(value.points[0]); data = `M ${p.x} ${p.y}` }
      for (let i = 0; i < segmentCount(value); i++) for (let k = 1; k <= 48; k++) { const p = screen(cubicPoint(pathSegment(value, i), k / 48)); data += ` L ${p.x} ${p.y}` }
      if (value.closed) data += ' Z'
      const body = node('path', { d: data }, 'path-outline')
      body.addEventListener('pointerdown', ev => {
        const e = ev as PointerEvent, hit = hitPathSegment(value, localEvent(e), 6, screen)
        if (hit && hit.t > 0.005 && hit.t < 0.995) {
          selected = hit.index + 1
          drag(e, t, insertPathPoint(value, hit.index, hit.t), map.toLocal, 'point', selected, true)
        } else drag(e, t, value, map.toLocal, 'body', 0)
      })
      value.points.forEach((p, i) => {
        const center = screen(p)
        if (selected === i) for (const kind of ['in', 'out'] as const) if (p[kind]) {
          const h = screen({ x: p.x + p[kind]![0], y: p.y + p[kind]![1] })
          node('line', { x1: center.x, y1: center.y, x2: h.x, y2: h.y }, 'path-tangent')
          const handle = node('circle', { cx: h.x, cy: h.y, r: 4 }, 'path-handle')
          handle.addEventListener('pointerdown', ev => drag(ev as PointerEvent, t, value, map.toLocal, kind, i))
        }
        const point = node('rect', { x: center.x - 4, y: center.y - 4, width: 8, height: 8, rx: 1 }, `path-point${selected === i ? ' selected' : ''}`)
        point.addEventListener('pointerdown', ev => {
          const e = ev as PointerEvent, at = performance.now(), position = localEvent(e)
          if (e.button !== 0) return
          const twice = lastClick?.index === i && at - lastClick.at < 350 && Math.hypot(position.x - lastClick.point.x, position.y - lastClick.point.y) < 5
          selected = i
          if (twice) { e.preventDefault(); e.stopPropagation(); finish?.(); lastClick = undefined; set(t, togglePathSmooth(t.value, i)); draw(); return }
          lastClick = { index: i, at, point: position }
          drag(e, t, value, map.toLocal, 'point', i); draw()
        })
      })
    }
    function drag(e: PointerEvent, t: NonNullable<ReturnType<typeof selectedPath>>, initial: PathValue, toLocal: (p: Point) => Point, kind: 'point' | 'body' | 'in' | 'out', index: number, inserted = false) {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation(); finish?.(); svg.focus({ preventScroll: true })
      const start = toLocal(localEvent(e)), at = app.edit.localTime(t.clipId)
      let last = initial, started = false
      const write = (v: PathValue) => { last = v; set(t, v, started ? 'update' : 'start', at); started = true }
      if (inserted) write(initial)
      const move = (ev: PointerEvent) => {
        lastClick = undefined
        const p = toLocal(localEvent(ev)), next = clonePath(initial), dx = p.x - start.x, dy = p.y - start.y
        if (kind === 'body') next.points.forEach(q => { q.x += dx; q.y += dy })
        else if (kind === 'point') { next.points[index].x += dx; next.points[index].y += dy }
        else {
          const q = next.points[index], handle = initial.points[index][kind] ?? [0, 0]
          q[kind] = [handle[0] + dx, handle[1] + dy]
          if (!ev.altKey) q[kind === 'in' ? 'out' : 'in'] = [-q[kind]![0], -q[kind]![1]]
        }
        if (next.points.every(q => [q.x, q.y, ...(q.in ?? []), ...(q.out ?? [])].every(Number.isFinite))) write(next)
      }
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
        finish = undefined
        if (started) set(t, last, 'end', at)
        draw()
      }
      finish = up
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    }
    const actions: PathEditorActions = {
      focus: () => { draw(); svg.focus({ preventScroll: true }) },
      hasPoint: () => !!selectedPath(app) && selected !== null,
      remove: () => {
        finish?.(); const t = selectedPath(app)
        if (!t || selected === null) return
        const value = clonePath(t.value); value.points.splice(selected, 1); selected = null; set(t, value); draw()
      },
      deselect: () => { selected = null; draw() }
    }
    app.services.set(SERVICE, actions)
    // Consume locally before the workbench's window handler can delete timeline clips.
    const key = (e: KeyboardEvent) => {
      if (document.activeElement !== svg || !selectedPath(app) || e.ctrlKey || e.metaKey || e.altKey) return
      const command = e.key === 'Delete' || e.key === 'Backspace' ? 'path.deletePoint' : e.key === 'Escape' ? 'path.deselectPoint' : null
      if (command) { e.preventDefault(); e.stopPropagation(); app.run(command) }
    }
    svg.addEventListener('keydown', key)
    const offFrame = ctx.onFrame(draw), offDoc = app.doc.onChange.on(draw), offSel = app.selection.property.subscribe(draw), offClip = app.selection.clips.subscribe(draw)
    draw()
    return () => { finish?.(); release?.(); offFrame(); offDoc.dispose(); offSel.dispose(); offClip.dispose(); svg.removeEventListener('keydown', key); svg.remove(); if (app.services.get(SERVICE) === actions) app.services.delete(SERVICE) }
  }
}
