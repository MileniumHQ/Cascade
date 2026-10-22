import { definePlugin } from '@core/plugin-api'
import { solidMount } from '../../solid'
import { ExportPanel } from './ExportPanel'
import { copyStill, exportStill } from './still'
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
    // The frame at the playhead, rendered at project resolution by the same worker the export uses.
    ctx.commands.register({ id: 'export.stillFrame', title: 'Export frame…', category: 'File', icon: 'image', enabled: (app) => !!app.host, run: (app) => exportStill(app) })
    ctx.commands.register({ id: 'export.copyFrame', title: 'Copy frame to clipboard', category: 'File', icon: 'copy', enabled: (app) => !!app.host, run: (app) => copyStill(app) })
    ctx.keybindings.register({ id: 'export.stillFrame:Mod+Shift+E', command: 'export.stillFrame', key: 'Mod+Shift+E' })
    ctx.menus.register({ id: 'menu:export.stillFrame', location: 'app/file', group: 'media', command: 'export.stillFrame', label: 'Export frame…', order: 26 })
    ctx.menus.register({ id: 'menu:export.copyFrame', location: 'app/file', group: 'media', command: 'export.copyFrame', label: 'Copy frame to clipboard', order: 27 })
    ctx.menus.register({ id: 'menu:export.open', location: 'app/file', group: 'media', command: 'export.open', label: 'Export…', order: 25 })
  }
})
