/** Drop into the user plugins folder: a timeline tool that seeks by clicking any lane. */
import type { PluginDefinition } from '../../src/core/plugin-api'
const plugin: PluginDefinition = {
  id: 'example.timeline-seek', name: 'Seek tool',
  activate(ctx) {
    ctx.timelineTools.register({
      id: 'example.seek', name: 'Seek', icon: 'play', cursor: 'crosshair',
      pointerDown(e, c) {
        c.app.playback.pause()
        c.app.playback.seek(c.snap(Math.max(0, c.timeAt(e.clientX)), new Set(), e.altKey))
      }
    })
  }
}
export default plugin
