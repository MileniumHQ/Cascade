import { definePlugin } from '@core/plugin-api'

export const timelinesPlugin = definePlugin({
  id: 'cascade.timelines', name: 'Timelines',
  activate(ctx) {
    ctx.commands.register({ id: 'timeline.create', title: 'New timeline', icon: 'plus', category: 'Timeline',
      run: a => { const id = a.edit.createTimeline(); a.edit.setActiveTimeline(id); return id } })
    ctx.commands.register({ id: 'timeline.switch', title: 'Switch timeline', category: 'Timeline', run: (a, id: string) => a.edit.setActiveTimeline(id) })
    ctx.commands.register({ id: 'timeline.duplicateTimeline', title: 'Duplicate timeline', icon: 'copy-plus', category: 'Timeline',
      run: (a, id = a.project().activeTimeline) => { const created = a.edit.duplicateTimeline(id); if (created) a.edit.setActiveTimeline(created); return created } })
    ctx.commands.register({ id: 'timeline.renameTimeline', title: 'Rename timeline', icon: 'pencil', category: 'Timeline',
      run: (a, id = a.project().activeTimeline, name?: string) => { if (name !== undefined) a.edit.renameTimeline(id, name); else a.events.emit('timeline:rename', id) } })
    ctx.commands.register({ id: 'timeline.deleteTimeline', title: 'Delete timeline', icon: 'trash-2', category: 'Timeline',
      run: (a, id = a.project().activeTimeline) => a.edit.deleteTimeline(id) })
    ctx.commands.register({ id: 'timeline.reorderTimeline', title: 'Reorder timeline', category: 'Timeline',
      run: (a, id: string, index: number) => a.edit.reorderTimeline(id, index) })
    ctx.commands.register({ id: 'timeline.back', title: 'Previous timeline', icon: 'arrow-left', category: 'Timeline',
      enabled: a => a.edit.timelineHistory.get().some(id => !!a.project().timelines[id]), run: a => a.edit.previousTimeline() })
    for (const [command, label, icon] of [
      ['timeline.create', 'New timeline', 'plus'], ['timeline.duplicateTimeline', 'Duplicate timeline', 'copy-plus'],
      ['timeline.renameTimeline', 'Rename timeline', 'pencil'], ['timeline.deleteTimeline', 'Delete timeline', 'trash-2'],
      ['timeline.back', 'Previous timeline', 'arrow-left']
    ]) ctx.menus.register({ id: `${command}.menu`, location: 'app/timeline', command, label, icon, group: 'timelines', order: 70 })
  }
})
