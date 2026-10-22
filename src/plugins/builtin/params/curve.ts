import type { ParamTypeContribution } from '@core/plugin-api'
import { coerceCurves, compileCurve, curveChannels, identityCurve, interpolateCurves, type CurveChannel, type CurveValue } from '@shared/curve'
import './geometry.css'

const COLORS = { master: '#eee', r: '#ec8888', g: '#8ecc9d', b: '#82cbff' }
export const curveParam: ParamTypeContribution<CurveValue> = {
  id: 'curve', interpolate: interpolateCurves, coerce: coerceCurves,
  format: v => `${curveChannels.reduce((n, c) => n + v[c].length, 0)} points`,
  editor(el, ctx) {
    const root = document.createElement('div'); root.className = 'curve-param'
    const tabs = document.createElement('div'); tabs.className = 'curve-tabs'
    const canvas = document.createElement('canvas'); canvas.className = 'curve-canvas'; canvas.width = canvas.height = 512
    canvas.title = 'Click to add. Drag to move; drag out or double-click to delete. Endpoints keep their input position.'
    const reset = document.createElement('button'); reset.className = 'btn btn-default btn-sm'; reset.textContent = 'Reset channel'
    let channel: CurveChannel = 'master', finish: (() => void) | undefined
    const buttons = curveChannels.map(c => {
      const b = document.createElement('button'); b.className = 'btn btn-default btn-sm'; b.textContent = c === 'master' ? 'Master' : c.toUpperCase()
      b.onclick = () => { finish?.(); channel = c; draw() }; tabs.append(b); return b
    })
    const draw = () => {
      buttons.forEach((b, i) => { b.dataset.active = String(curveChannels[i] === channel) })
      const g = canvas.getContext('2d'); if (!g) return
      g.clearRect(0, 0, 512, 512); g.fillStyle = '#202020'; g.fillRect(0, 0, 512, 512)
      const coord = (v: number) => 16 + v * 480
      g.strokeStyle = '#383838'; g.lineWidth = 1
      for (let i = 0; i <= 4; i++) { const k = coord(i / 4); g.beginPath(); g.moveTo(k, 16); g.lineTo(k, 496); g.moveTo(16, k); g.lineTo(496, k); g.stroke() }
      const points = coerceCurves(ctx.get())[channel], sample = compileCurve(points)
      g.strokeStyle = COLORS[channel]; g.lineWidth = 3; g.beginPath()
      for (let i = 0; i <= 480; i++) { const x = i / 480, y = coord(1 - sample(x)); i ? g.lineTo(coord(x), y) : g.moveTo(coord(x), y) }; g.stroke()
      for (const [x, y] of points) { g.beginPath(); g.arc(coord(x), coord(1 - y), 6, 0, Math.PI * 2); g.fillStyle = '#202020'; g.fill(); g.stroke() }
    }
    const position = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 512 / 480 - 16 / 480, 1 - ((e.clientY - r.top) / r.height * 512 / 480 - 16 / 480)] as [number, number] }
    const nearest = (e: MouseEvent, v: CurveValue) => {
      const [x, y] = position(e), r = canvas.getBoundingClientRect(), tolerance = 10 / Math.max(1, r.width) * 512 / 480
      return v[channel].findIndex(p => Math.hypot(p[0] - x, p[1] - y) < tolerance)
    }
    canvas.onpointerdown = e => {
      if (e.button !== 0 || e.detail > 1) return
      e.preventDefault(); e.stopPropagation(); finish?.()
      const value = coerceCurves(ctx.get()), points = value[channel], [x, y] = position(e)
      let index = nearest(e, value), moved = false
      if (index < 0) {
        if (x <= 0 || x >= 1 || y < 0 || y > 1) return
        index = points.findIndex(p => p[0] > x)
        // Do not create coincident input positions.
        if (points.some(p => Math.abs(p[0] - x) < 0.002)) return
        points.splice(index, 0, [x, y]); moved = true
      }
      let last = value, started = false
      const write = (v: CurveValue) => { last = structuredClone(v); ctx.set(last, { gesture: started ? 'update' : 'start' }); started = true }
      if (moved) write(value)
      const move = (ev: PointerEvent) => {
        const [px, py] = position(ev), current = structuredClone(value), p = current[channel]
        if (index > 0 && index < p.length - 1 && (px < -0.08 || px > 1.08 || py < -0.08 || py > 1.08)) p.splice(index, 1)
        else p[index] = [index === 0 ? 0 : index === p.length - 1 ? 1 : Math.max(p[index - 1][0] + 1e-5, Math.min(p[index + 1][0] - 1e-5, px)), Math.max(0, Math.min(1, py))]
        write(current)
      }
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
        if (started) ctx.set(last, { gesture: 'end' }); finish = undefined
      }
      finish = up
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    }
    canvas.ondblclick = e => {
      e.preventDefault(); finish?.()
      const v = coerceCurves(ctx.get()), index = nearest(e, v)
      if (index > 0 && index < v[channel].length - 1) { v[channel].splice(index, 1); ctx.set(v) }
    }
    reset.onclick = () => { finish?.(); const v = coerceCurves(ctx.get()); v[channel] = identityCurve(); ctx.set(v) }
    root.append(tabs, canvas, reset); el.append(root)
    const off = ctx.subscribe(draw); draw()
    return () => { finish?.(); off(); root.remove() }
  }
}
