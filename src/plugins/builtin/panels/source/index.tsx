import type { CascadeAPI } from '@core/app'
import type { PlaceMode } from '@core/three-point'
import { definePlugin, type CommandContribution, type KeybindingContribution } from '@core/plugin-api'
import { formatTimecode } from '@shared/time'
import { solidMount } from '../../solid'
import { markedRange, marksOf } from './marks'
import { SourceMonitor } from './service'
import { SourceMonitorView } from './SourceMonitor'
import { rippleOptions } from '../../ripple'

const monitor = (app: CascadeAPI) => app.services.get('source') as SourceMonitor

/** The item an edit takes from: the open one, else the one picked in the Sources panel. */
const sourceItem = (app: CascadeAPI) => monitor(app).mediaId.get() ?? app.selection.media.get()[0] ?? null

/** Three-point edit of the source item with its marks, then park the playhead after the new clip. */
function place(app: CascadeAPI, mode: PlaceMode) {
  const id = sourceItem(app)
  if (!id) return
  const mon = monitor(app)
  const marks = mon.mediaId.get() === id ? mon.marks.get() : marksOf(app.project(), id)
  const res = app.edit.placeSource(mode, id, { sourceIn: marks.in, sourceOut: marks.out, lanes: mon.lanes.get(), rippleMarkers: rippleOptions(app).rippleMarkers })
  if (!res) return
  app.playback.pause()
  app.playback.seek(res.end)
  const fps = app.fps()
  if (res.fit) {
    const length = app.project().media[id]?.meta.duration
    const src = length ? markedRange(marks, length) : null
    if (src && src.end - src.start !== res.end - res.start)
      app.notify('info', 'Fit to the timeline in/out', `Used ${formatTimecode(res.end - res.start, fps)} of the source; the clip isn't sped up or slowed down.`)
  } else if (res.shortened) app.notify('info', 'The source is shorter than the range', `Placed ${formatTimecode(res.end - res.start, fps)}.`)
}

/**
 * Source monitor: previews one media item with its own transport and in/out marks, and
 * three-point edits (insert / overwrite / append) from it. Sits beside the Preview as a tab.
 */
export const sourcePlugin = definePlugin({
  id: 'cascade.panel.source',
  name: 'Source monitor',
  activate(ctx) {
    const mon = new SourceMonitor(ctx.app)
    ctx.app.services.set('source', mon)
    ctx.track({
      dispose() {
        mon.dispose()
        if (ctx.app.services.get('source') === mon) ctx.app.services.delete('source')
      }
    })
    // Timeline playback shows the timeline: bring the Preview tab forward when it starts.
    ctx.track(ctx.app.playback.playing.subscribe((p) => p && ctx.app.layout.reveal('preview')))
    ctx.panels.register({ id: 'source', title: 'Source', icon: 'source-monitor', region: 'top', order: 1, group: 'viewer', mount: solidMount(SourceMonitorView) })

    const hasItem = (a: CascadeAPI) => !!sourceItem(a)
    const cmds: CommandContribution[] = [
      {
        id: 'source.open',
        title: 'Open in source monitor',
        icon: 'source-monitor',
        category: 'Source',
        run(a, id) {
          const target = (typeof id === 'string' ? id : a.selection.media.get().at(-1)) ?? null
          if (!target) return
          monitor(a).open(target)
          a.layout.reveal('source')
        }
      },
      { id: 'source.toggle', title: 'Source: play / pause', icon: 'play', category: 'Source', run: (a) => (monitor(a).playback.setRate(1), monitor(a).playback.toggle()) },
      { id: 'source.stepBack', title: 'Source: previous frame', category: 'Source', run: (a, n = 1) => monitor(a).playback.stepFrames(-Number(n)) },
      { id: 'source.stepForward', title: 'Source: next frame', category: 'Source', run: (a, n = 1) => monitor(a).playback.stepFrames(Number(n)) },
      { id: 'source.start', title: 'Source: go to start', category: 'Source', run: (a) => (monitor(a).playback.pause(), monitor(a).playback.seek(0)) },
      { id: 'source.end', title: 'Source: go to end', category: 'Source', run: (a) => (monitor(a).playback.pause(), monitor(a).playback.seek(monitor(a).duration())) },
      {
        id: 'source.shuttle',
        title: 'Source: shuttle (J/K/L)',
        category: 'Source',
        run(a, dir) {
          const p = monitor(a).playback
          const d = Number(dir)
          if (d === 0) {
            p.pause()
            p.setRate(1)
            return
          }
          const r = p.rate.get()
          p.setRate(p.playing.get() && Math.sign(r) === d ? Math.max(-8, Math.min(8, r * 2)) : d)
          p.play()
        }
      },
      { id: 'source.markIn', title: 'Source: mark in', icon: 'mark-in', category: 'Source', run: (a) => monitor(a).markIn(), enabled: (a) => !!monitor(a).mediaId.get() },
      { id: 'source.markOut', title: 'Source: mark out', icon: 'mark-out', category: 'Source', run: (a) => monitor(a).markOut(), enabled: (a) => !!monitor(a).mediaId.get() },
      { id: 'source.clearMarks', title: 'Source: clear in/out', category: 'Source', run: (a) => monitor(a).clearMarks() },
      { id: 'source.goToIn', title: 'Source: go to in', category: 'Source', run: (a) => monitor(a).goToIn() },
      { id: 'source.goToOut', title: 'Source: go to out', category: 'Source', run: (a) => monitor(a).goToOut() },

      { id: 'edit.insert', title: 'Insert', icon: 'edit-insert', category: 'Edit', run: (a) => place(a, 'insert'), enabled: hasItem },
      { id: 'edit.overwrite', title: 'Overwrite', icon: 'edit-overwrite', category: 'Edit', run: (a) => place(a, 'overwrite'), enabled: hasItem },
      { id: 'edit.appendToEnd', title: 'Append to end', icon: 'edit-append', category: 'Edit', run: (a) => place(a, 'append'), enabled: hasItem }
    ]
    for (const c of cmds) ctx.commands.register(c)

    const src = (key: string, command: string, args?: unknown[]): Omit<KeybindingContribution, 'id'> => ({ key, command, args, when: 'source' })
    const keys: Omit<KeybindingContribution, 'id'>[] = [
      // Scoped to the source monitor: they win over the timeline's own bindings while it is under the pointer.
      src('Space', 'source.toggle'),
      src('J', 'source.shuttle', [-1]),
      src('K', 'source.shuttle', [0]),
      src('L', 'source.shuttle', [1]),
      src('ArrowLeft', 'source.stepBack'),
      src('ArrowRight', 'source.stepForward'),
      src('Shift+ArrowLeft', 'source.stepBack', [10]),
      src('Shift+ArrowRight', 'source.stepForward', [10]),
      src('Home', 'source.start'),
      src('End', 'source.end'),
      src('I', 'source.markIn'),
      src('O', 'source.markOut'),
      src('Alt+X', 'source.clearMarks'),
      src('Shift+I', 'source.goToIn'),
      src('Shift+O', 'source.goToOut'),
      { key: ',', command: 'edit.insert' },
      { key: '.', command: 'edit.overwrite' },
      { key: 'Shift+E', command: 'edit.appendToEnd' }
    ]
    for (const k of keys) ctx.keybindings.register({ id: `${k.command}:${k.when ?? ''}:${k.key}`, ...k })

    ctx.menus.register({ id: 'menu:source.open:context', location: 'source/context', command: 'source.open', label: 'Open in source monitor', icon: 'source-monitor', shortcut: 'Enter', order: -10 })
    const edit: [string, string][] = [
      ['edit.insert', 'Insert'],
      ['edit.overwrite', 'Overwrite'],
      ['edit.appendToEnd', 'Append to End']
    ]
    edit.forEach(([command, label], i) => ctx.menus.register({ id: `menu:${command}`, location: 'app/edit', group: 'source', command, label, order: 500 + i }))
    ctx.menus.register({ id: 'menu:source.open', location: 'app/edit', group: 'source', command: 'source.open', label: 'Open in Source Monitor', order: 499 })
  }
})
