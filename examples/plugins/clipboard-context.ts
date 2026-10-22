/** A clipboard format can handle explicit targets without depending on built-in codecs. */
import type { PluginDefinition } from '../../src/core/plugin-api'
export default {
  id: 'example.clipboard-context', name: 'Clip names clipboard',
  activate(ctx) {
    ctx.clipboardFormats.register({
      id: 'example.clip-names', priority: -2000,
      canCopy: (app, context) => !context?.property && (context?.ids ?? app.selection.clips.get()).length > 0,
      copy: (app, context) => (context?.ids ?? app.selection.clips.get()).flatMap(id => app.timeline().tracks.flatMap(t => t.clips.filter(c => c.id === id).map(c => c.name))),
      canPaste: (_app, data) => Array.isArray(data) && data.every(v => typeof v === 'string'),
      paste: (app, data) => { app.notify('info', (data as string[]).join(', ')) }
    })
  }
} satisfies PluginDefinition
