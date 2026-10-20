import type { CascadeAPI } from '@core/app'
import { formatRulerLabel, rulerStep, type Flicks } from '@shared/time'

/** Draw the adaptive time ruler (labels shorten as you zoom out) into a canvas. */
export function drawRuler(canvas: HTMLCanvasElement, app: CascadeAPI, opts: { inPoint?: Flicks; outPoint?: Flicks; markers: { t: Flicks; color?: string }[] }) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const g = canvas.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const css = getComputedStyle(canvas)
  const text = css.getPropertyValue('--muted').trim() || '#8d8d96'
  const tick = css.getPropertyValue('--line-3').trim() || 'rgba(255,255,255,.18)'
  const fps = app.fps()
  const pps = app.view.pxPerSecond.get()
  const scroll = app.view.scrollX.get()
  const { major, minor } = rulerStep(pps, fps, 90)
  const t0 = app.view.pxToTime(scroll)
  const t1 = app.view.pxToTime(scroll + w)

  // in/out range
  if (opts.inPoint !== undefined || opts.outPoint !== undefined) {
    const a = opts.inPoint ?? 0
    const b = opts.outPoint ?? app.duration()
    const x0 = app.view.timeToPx(a) - scroll
    const x1 = app.view.timeToPx(b) - scroll
    g.fillStyle = 'rgba(130, 203, 255, 0.12)'
    g.fillRect(x0, 0, x1 - x0, h)
    g.fillStyle = 'rgba(130, 203, 255, 0.7)'
    g.fillRect(x0, h - 2, x1 - x0, 2)
  }

  g.strokeStyle = tick
  g.lineWidth = 1
  g.beginPath()
  const firstMinor = Math.floor(t0 / minor) * minor
  for (let t = firstMinor; t <= t1 + minor; t += minor) {
    const x = Math.round(app.view.timeToPx(t) - scroll) + 0.5
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
    const len = isMajor ? 9 : 4
    g.moveTo(x, h - len)
    g.lineTo(x, h)
  }
  g.stroke()

  g.fillStyle = text
  g.font = `500 10.5px ${css.getPropertyValue('--font') || 'sans-serif'}`
  g.textBaseline = 'top'
  const firstMajor = Math.floor(t0 / major) * major
  for (let t = Math.max(0, firstMajor); t <= t1 + major; t += major) {
    const x = Math.round(app.view.timeToPx(t) - scroll)
    g.fillText(formatRulerLabel(t, fps, major), x + 4, 5)
  }

  for (const m of opts.markers) {
    const x = Math.round(app.view.timeToPx(m.t) - scroll)
    if (x < -10 || x > w + 10) continue
    g.fillStyle = m.color ?? '#f2c14e'
    g.beginPath()
    g.moveTo(x - 4, h - 12)
    g.lineTo(x + 4, h - 12)
    g.lineTo(x + 4, h - 6)
    g.lineTo(x, h - 2)
    g.lineTo(x - 4, h - 6)
    g.closePath()
    g.fill()
  }
}
