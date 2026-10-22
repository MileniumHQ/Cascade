/** Silent four-view contact display using the same generic composition service as sequences.
 * Create two timelines, add content to one, select the other, then invoke example.grid.add.
 * Drop in Settings → Plugins; the command appears in the Timeline menu. */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.timeline-grid', name: 'Timeline grid',
  activate(ctx) {
    ctx.mediaTypes.register({
      id: 'example.timeline-grid', name: 'Timeline grid', icon: 'layout-grid', color: '#8d9d8d', track: 'visual', timeBased: true,
      sourceMeta(media, project) {
        const tl = media.timelineId && project.timelines[media.timelineId]
        const duration = tl ? Math.max(0, ...tl.tracks.flatMap(t => t.clips.map(c => c.start + c.duration))) : 0
        return { duration, width: project.settings.width, height: project.settings.height }
      },
      hasAudio: () => false,
      stage: {
        mount(m) {
          const el = m.document.createElement('div')
          el.style.cssText = 'display:grid;grid-template:1fr 1fr/1fr 1fr;width:100cqw;height:100cqh;gap:.5cqh'
          const views = Array.from({ length: 4 }, (_, i) => {
            const cell = m.document.createElement('div')
            cell.style.cssText = 'position:relative;min-width:0;min-height:0;overflow:hidden'
            el.appendChild(cell)
            return { offset: i * .25, child: m.media?.timelineId ? m.compositions?.mount(m.media.timelineId, cell, { audio: false }) : undefined }
          })
          return {
            el,
            update(s) { for (const v of views) v.child?.update({ ...s, sourceTime: s.sourceTime + v.offset }) },
            async prepare(s) { await Promise.all(views.map(v => v.child?.prepare({ ...s, sourceTime: s.sourceTime + v.offset }))) },
            dispose() { for (const v of views) v.child?.dispose() }
          }
        }
      }
    })
    ctx.commands.register({ id: 'example.grid.add', title: 'Add timeline grid', category: 'Timeline', run(app) {
      const target = app.project().timelineOrder.find(id => id !== app.project().activeTimeline)
      if (target) return app.edit.addComposition(target, 'example.timeline-grid')
      app.notify('info', 'Create a second timeline first')
    } })
    ctx.menus.register({ id: 'example.grid.menu', location: 'app/timeline', label: 'Add timeline grid', command: 'example.grid.add' })
  }
}
export default plugin
