import type { SourceItemDecorationContribution } from '@core/plugin-api'
import { marksOf } from './marks'

/** In/out range marked in the source monitor, drawn along the bottom of a Sources item. */
export const marksDecoration: SourceItemDecorationContribution = {
  id: 'source.marks',
  mount(el, ctx) {
    const bar = document.createElement('span')
    bar.className = 'sc-marks'
    bar.dataset.tip = 'Marked in the source monitor'
    el.append(bar)
    const draw = () => {
      const d = ctx.media()?.meta.duration, m = marksOf(ctx.app.project(), ctx.mediaId)
      if (!d || (m.in === undefined && m.out === undefined)) return void (bar.style.display = 'none')
      const a = Math.min(1, Math.max(0, (m.in ?? 0) / d)), b = Math.min(1, Math.max(a, (m.out ?? d) / d))
      bar.style.display = ''
      bar.style.left = `${a * 100}%`
      bar.style.width = `${(b - a) * 100}%`
    }
    draw()
    const off = ctx.subscribe(draw)
    return () => { off(); bar.remove() }
  }
}
