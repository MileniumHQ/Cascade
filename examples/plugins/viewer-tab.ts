/**
 * Example Cascade plugin: a panel that joins the Preview's viewer slot as a tab.
 *
 * Panels of one region that share a `group` share a single slot, shown as tabs (the built-in
 * Source monitor does exactly this). `app.layout.reveal(id)` brings a tab to the front.
 */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.viewer-tab',
  name: 'Viewer tab',
  activate(ctx) {
    ctx.panels.register({
      id: 'example.notes',
      title: 'Notes',
      icon: 'file-text',
      region: 'top',
      group: 'viewer',
      mount(el, { app }) {
        el.style.cssText = 'padding:16px;color:var(--text-2)'
        const render = () => (el.textContent = `${app.project().name}: ${app.duration() / 705_600_000}s`)
        render()
        const sub = app.doc.onChange.on(render)
        return () => sub.dispose()
      }
    })
  }
}

export default plugin
