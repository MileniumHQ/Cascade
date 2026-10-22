/** Copy into Settings → Plugins → Open folder. All imports are erased; no runtime dependencies. */
import type { PluginDefinition, PathValue } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.path-window', name: 'Path window',
  activate(ctx) {
    ctx.properties.register({
      id: 'example.path-window', name: 'Path window', category: 'Compositing', icon: 'square-dashed',
      description: 'A custom path mask using the shared parameter editor and preview overlay', stackable: true,
      params: [
        { id: 'outline', label: 'Outline', type: 'path', default: { closed: true, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] } satisfies PathValue },
        { id: 'softness', label: 'Softness', type: 'number', unit: 'frameLen', default: 0.02, min: 0, step: 1 }
      ],
      apply(values) {
        const p = values.outline as PathValue
        const xy = (x: number, y: number) => `${Number.isFinite(x) ? x : 0} ${Number.isFinite(y) ? y : 0}`
        let d = p.points.length ? `M ${xy(p.points[0].x, p.points[0].y)}` : ''
        for (let i = 0; i < p.points.length - (p.closed ? 0 : 1); i++) {
          const a = p.points[i], b = p.points[(i + 1) % p.points.length]
          d += ` C ${xy(a.x + (a.out?.[0] ?? 0), a.y + (a.out?.[1] ?? 0))} ${xy(b.x + (b.in?.[0] ?? 0), b.y + (b.in?.[1] ?? 0))} ${xy(b.x, b.y)}`
        }
        if (p.closed) d += ' Z'
        const softness = Math.max(0, Number(values.softness) || 0)
        return { mask: [{ mode: 'intersect', svg: box => {
          const sx = softness * box.frame.height / Math.max(1, box.width), sy = softness * box.frame.height / Math.max(1, box.height)
          return `<defs><filter id="soft" filterUnits="userSpaceOnUse" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="${sx} ${sy}"/></filter></defs><path d="${d}" fill="white" filter="url(#soft)"/>`
        } }] }
      }
    })
  }
}
export default plugin
