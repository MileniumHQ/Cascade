/** Drop into Settings → Plugins → Open folder. No core or timeline changes required. */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.iris-transition', name: 'Iris transition',
  activate(ctx) {
    ctx.transitions.register({
      id: 'example.iris', name: 'Iris', description: 'Reveal the next picture through a growing circle.',
      icon: 'circle', kinds: ['visual'], defaultDuration: 0.75,
      params: [{ id: 'origin', label: 'Origin', type: 'vec2', default: [0.5, 0.5], unit: 'frameXY' }],
      apply(p, values, { u, to }) {
        const origin = values.origin as [number, number]
        const mask = (amount: number) => `circle(${amount * 150}% at ${u.x(origin[0])} ${u.y(origin[1])})`
        return { from: { style: { 'clip-path': to ? 'none' : mask(1 - p) } }, to: { style: { 'clip-path': mask(p) } } }
      }
    })
  }
}
export default plugin
