import { definePlugin } from '@core/plugin-api'
import { solidMount } from '../../solid'
import { ExportPanel } from './ExportPanel'
import './export.css'

/** The one place to export: format list, settings, and job progress. */
export const exportPanelPlugin = definePlugin({
  id: 'cascade.panel.export',
  name: 'Export',
  activate(ctx) {
    ctx.panels.register({ id: 'export', title: 'Export', icon: 'clapperboard', region: 'bottom', order: 2, mount: solidMount(ExportPanel) })
    // Shortcut only opens the tab: the panel's Export button stays the single export action.
    ctx.commands.register({ id: 'export.open', title: 'Export…', category: 'File', icon: 'clapperboard', run: (app) => app.layout.activeBottom.set('export') })
    ctx.keybindings.register({ id: 'export.open:Mod+E', command: 'export.open', key: 'Mod+E' })
    ctx.menus.register({ id: 'menu:export.open', location: 'app/file', group: 'media', command: 'export.open', label: 'Export…', order: 25 })
  }
})
