import { definePlugin, type CommandContribution, type KeybindingContribution, type MenuItemContribution, type MenuLocation } from '@core/plugin-api'
import type { CascadeAPI } from '@core/app'
import { clipEnd, findClip } from '@shared/project'
import { rippleOptions } from './ripple'

interface SessionLike {
  save(): Promise<unknown>
  saveAs(): Promise<unknown>
  openDialog(): Promise<unknown>
}
const session = (app: CascadeAPI) => app.services.get('session') as SessionLike | undefined
const sel = (app: CascadeAPI) => app.selection.clips.get()

/** Transport, editing and project commands with their default shortcuts. */
export const commandsPlugin = definePlugin({
  id: 'cascade.commands',
  name: 'Core commands',
  activate(ctx) {
    const cmds: CommandContribution[] = [
      // history & project
      { id: 'edit.undo', title: 'Undo', icon: 'undo-2', category: 'Edit', run: (a) => a.doc.undo(), enabled: (a) => a.doc.canUndo },
      { id: 'edit.redo', title: 'Redo', icon: 'redo-2', category: 'Edit', run: (a) => a.doc.redo(), enabled: (a) => a.doc.canRedo },
      { id: 'project.save', title: 'Save project', icon: 'save', category: 'Project', run: (a) => void session(a)?.save() },
      { id: 'project.saveAs', title: 'Save project as…', icon: 'save-all', category: 'Project', run: (a) => void session(a)?.saveAs() },
      { id: 'project.open', title: 'Open project…', icon: 'folder-open', category: 'Project', run: (a) => void session(a)?.openDialog() },
      {
        id: 'media.import',
        title: 'Import media…',
        icon: 'import',
        category: 'Media',
        async run(a) {
          const files = await a.host?.dialog.openFiles({ title: 'Import media', multi: true })
          if (files?.length) await a.edit.importFiles(files)
        }
      },

      // transport
      { id: 'playback.toggle', title: 'Play / pause', icon: 'play', category: 'Playback', run: (a) => (a.playback.setRate(1), a.playback.toggle()) },
      { id: 'playback.stepBack', title: 'Previous frame', icon: 'step-back', category: 'Playback', run: (a, n = 1) => a.playback.stepFrames(-Number(n)) },
      { id: 'playback.stepForward', title: 'Next frame', icon: 'step-forward', category: 'Playback', run: (a, n = 1) => a.playback.stepFrames(Number(n)) },
      { id: 'playback.start', title: 'Go to start', icon: 'skip-back', category: 'Playback', run: (a) => (a.playback.pause(), a.playback.seek(0)) },
      { id: 'playback.end', title: 'Go to end', icon: 'skip-forward', category: 'Playback', run: (a) => (a.playback.pause(), a.playback.seek(a.duration())) },
      {
        id: 'playback.shuttle',
        title: 'Shuttle (J/K/L)',
        category: 'Playback',
        run(a, dir) {
          const p = a.playback
          const d = Number(dir)
          if (d === 0) {
            p.pause()
            p.setRate(1)
            return
          }
          const r = p.rate.get()
          const next = p.playing.get() && Math.sign(r) === d ? Math.max(-8, Math.min(8, r * 2)) : d
          p.setRate(next)
          p.play()
        }
      },
      { id: 'playback.loop', title: 'Toggle loop', icon: 'repeat', category: 'Playback', run: (a) => a.playback.loop.set(!a.playback.loop.get()) },
      {
        id: 'playback.prevEdit',
        title: 'Previous edit point',
        category: 'Playback',
        run: (a) => jumpEdit(a, -1)
      },
      { id: 'playback.nextEdit', title: 'Next edit point', category: 'Playback', run: (a) => jumpEdit(a, 1) },

      // timeline editing
      { id: 'timeline.split', title: 'Split at playhead', icon: 'scissors', category: 'Timeline', run: (a) => void a.edit.splitAt(a.playback.time.get()) },
      { id: 'timeline.delete', title: 'Delete', icon: 'trash-2', category: 'Timeline', run: (a) => a.selection.markers.get().length ? a.edit.removeMarkers(a.selection.markers.get()) : a.selection.transitions.get().length ? a.edit.removeTransitions(a.selection.transitions.get()) : a.edit.deleteClips(sel(a), rippleOptions(a)), enabled: (a) => sel(a).length > 0 || a.selection.markers.get().length > 0 || a.selection.transitions.get().length > 0 },
      { id: 'timeline.rippleDelete', title: 'Ripple delete', icon: 'trash', category: 'Timeline', run: (a) => a.edit.deleteClips(sel(a), { ...rippleOptions(a), ripple: true }), enabled: (a) => sel(a).length > 0 },
      { id: 'timeline.duplicate', title: 'Duplicate', icon: 'copy-plus', category: 'Timeline', run: (a) => a.edit.duplicateClips(sel(a)), enabled: (a) => sel(a).length > 0 },
      {
        id: 'timeline.selectAll',
        title: 'Select all clips',
        category: 'Timeline',
        run: (a) => a.selection.setClips(a.timeline().tracks.flatMap((t) => t.clips.map((c) => c.id)))
      },
      { id: 'timeline.deselect', title: 'Deselect', category: 'Timeline', run: (a) => (a.selection.setClips([]), a.selection.keyframes.set([])) },
      { id: 'timeline.unlink', title: 'Unlink audio/video', icon: 'unlink', category: 'Timeline', run: (a) => a.edit.unlink(sel(a)) },
      { id: 'timeline.link', title: 'Link clips', icon: 'link', category: 'Timeline', run: (a) => a.edit.link(sel(a)) },
      {
        id: 'timeline.trimStart',
        title: 'Trim start to playhead',
        category: 'Timeline',
        run: (a) => trimToPlayhead(a, 'start')
      },
      { id: 'timeline.trimEnd', title: 'Trim end to playhead', category: 'Timeline', run: (a) => trimToPlayhead(a, 'end') },
      { id: 'timeline.marker', title: 'Add marker', icon: 'bookmark', category: 'Timeline', run: (a) => a.run('markers.add') },
      { id: 'timeline.snapping', title: 'Toggle snapping', icon: 'magnet', category: 'Timeline', run: (a) => a.view.snapping.set(!a.view.snapping.get()) },
      { id: 'timeline.zoomIn', title: 'Zoom in', icon: 'zoom-in', category: 'Timeline', run: (a) => a.view.zoomAround(1.5, a.view.timeToPx(a.playback.time.get()) - a.view.scrollX.get()) },
      { id: 'timeline.zoomOut', title: 'Zoom out', icon: 'zoom-out', category: 'Timeline', run: (a) => a.view.zoomAround(1 / 1.5, a.view.timeToPx(a.playback.time.get()) - a.view.scrollX.get()) },
      {
        id: 'timeline.zoomFit',
        title: 'Zoom to fit',
        icon: 'scan',
        category: 'Timeline',
        run(a) {
          const d = a.duration() / 705_600_000
          if (d <= 0) return
          a.view.pxPerSecond.set(Math.min(4000, Math.max(0.02, (a.view.viewportWidth.get() - 40) / d)))
          a.view.scrollX.set(0)
        }
      },
      {
        id: 'timeline.setIn',
        title: 'Mark in',
        category: 'Timeline',
        run: (a) => a.doc.transact('Mark in', (d) => void (d.timelines[d.activeTimeline].inPoint = a.playback.time.get()))
      },
      {
        id: 'timeline.setOut',
        title: 'Mark out',
        category: 'Timeline',
        run: (a) => a.doc.transact('Mark out', (d) => void (d.timelines[d.activeTimeline].outPoint = a.playback.time.get()))
      },
      {
        id: 'timeline.clearInOut',
        title: 'Clear in/out',
        category: 'Timeline',
        run: (a) =>
          a.doc.transact('Clear in/out', (d) => {
            delete d.timelines[d.activeTimeline].inPoint
            delete d.timelines[d.activeTimeline].outPoint
          })
      },

      // keyframes
      {
        id: 'keyframes.prev',
        title: 'Previous keyframe',
        category: 'Keyframes',
        run(a) {
          const c = a.selection.primaryClip
          const t = c && a.edit.adjacentKeyframe(c, -1)
          if (typeof t === 'number') (a.playback.pause(), a.playback.seek(t))
        }
      },
      {
        id: 'keyframes.next',
        title: 'Next keyframe',
        category: 'Keyframes',
        run(a) {
          const c = a.selection.primaryClip
          const t = c && a.edit.adjacentKeyframe(c, 1)
          if (typeof t === 'number') (a.playback.pause(), a.playback.seek(t))
        }
      },
      {
        id: 'keyframes.delete',
        title: 'Delete selected keyframes',
        category: 'Keyframes',
        run: (a) => a.edit.removeKeyframes(a.selection.keyframes.get()),
        enabled: (a) => a.selection.keyframes.get().length > 0
      }
    ]
    for (const c of cmds) ctx.commands.register(c)

    const keys: Omit<KeybindingContribution, 'id'>[] = [
      { key: 'Mod+Z', command: 'edit.undo' },
      { key: 'Mod+Shift+Z', command: 'edit.redo' },
      { key: 'Mod+Y', command: 'edit.redo' },
      { key: 'Mod+S', command: 'project.save' },
      { key: 'Mod+Shift+S', command: 'project.saveAs' },
      { key: 'Mod+O', command: 'project.open' },
      { key: 'Mod+I', command: 'media.import' },
      { key: 'Space', command: 'playback.toggle' },
      { key: 'ArrowLeft', command: 'playback.stepBack' },
      { key: 'ArrowRight', command: 'playback.stepForward' },
      { key: 'Shift+ArrowLeft', command: 'playback.stepBack', args: [10] },
      { key: 'Shift+ArrowRight', command: 'playback.stepForward', args: [10] },
      { key: 'ArrowUp', command: 'playback.prevEdit' },
      { key: 'ArrowDown', command: 'playback.nextEdit' },
      { key: 'Home', command: 'playback.start' },
      { key: 'End', command: 'playback.end' },
      { key: 'J', command: 'playback.shuttle', args: [-1] },
      { key: 'K', command: 'playback.shuttle', args: [0] },
      { key: 'L', command: 'playback.shuttle', args: [1] },
      { key: 'Mod+B', command: 'timeline.split' },
      { key: 'S', command: 'timeline.split' },
      { key: 'Delete', command: 'timeline.delete' },
      { key: 'Backspace', command: 'timeline.delete' },
      { key: 'Shift+Delete', command: 'timeline.rippleDelete' },
      { key: 'Shift+Backspace', command: 'timeline.rippleDelete' },
      { key: 'Mod+D', command: 'timeline.duplicate' },
      { key: 'Mod+A', command: 'timeline.selectAll' },
      { key: 'Escape', command: 'timeline.deselect' },
      { key: 'Mod+Shift+L', command: 'timeline.unlink' },
      { key: 'Q', command: 'timeline.trimStart' },
      { key: 'W', command: 'timeline.trimEnd' },
      { key: 'N', command: 'timeline.snapping' },
      { key: '=', command: 'timeline.zoomIn' },
      { key: '-', command: 'timeline.zoomOut' },
      { key: 'Shift+Z', command: 'timeline.zoomFit' },
      { key: 'Mod+=', command: 'timeline.zoomIn' },
      { key: 'Mod+-', command: 'timeline.zoomOut' },
      { key: 'Mod+0', command: 'timeline.zoomFit' },
      { key: 'Plus', command: 'timeline.zoomIn' },
      { key: 'Shift+Plus', command: 'timeline.zoomIn' },
      { key: 'Mod+Shift+Plus', command: 'timeline.zoomIn' },
      { key: 'Mod+K', command: 'timeline.split' },
      { key: 'I', command: 'timeline.setIn' },
      { key: 'O', command: 'timeline.setOut' },
      { key: 'Alt+X', command: 'timeline.clearInOut' },
      { key: '[', command: 'keyframes.prev' },
      { key: ']', command: 'keyframes.next' },
      { key: 'Delete', command: 'keyframes.delete', when: 'keyframes' },
      { key: 'Backspace', command: 'keyframes.delete', when: 'keyframes' }
    ]
    for (const k of keys) ctx.keybindings.register({ id: `${k.command}:${k.key}`, ...k })

    // Native application menu. Groups become separator-delimited sections, in order of their first item.
    const menu: [MenuLocation, string, string, string, Partial<MenuItemContribution>?][] = [
      ['app/file', 'project', 'project.save', 'Save'],
      ['app/file', 'project', 'project.saveAs', 'Save As…'],
      ['app/file', 'media', 'media.import', 'Import Media…'],
      ['app/edit', 'history', 'edit.undo', 'Undo'],
      ['app/edit', 'history', 'edit.redo', 'Redo'],
      ['app/edit', 'clips', 'timeline.split', 'Split at Playhead'],
      ['app/edit', 'clips', 'timeline.duplicate', 'Duplicate'],
      ['app/edit', 'clips', 'timeline.delete', 'Delete'],
      ['app/edit', 'clips', 'timeline.rippleDelete', 'Ripple Delete'],
      ['app/edit', 'trim', 'timeline.trimStart', 'Trim Start to Playhead'],
      ['app/edit', 'trim', 'timeline.trimEnd', 'Trim End to Playhead'],
      ['app/edit', 'select', 'timeline.selectAll', 'Select All Clips'],
      ['app/edit', 'select', 'timeline.deselect', 'Deselect'],
      ['app/edit', 'link', 'timeline.link', 'Link Clips'],
      ['app/edit', 'link', 'timeline.unlink', 'Unlink Clips'],
      ['app/timeline', 'marks', 'timeline.setIn', 'Mark In'],
      ['app/timeline', 'marks', 'timeline.setOut', 'Mark Out'],
      ['app/timeline', 'marks', 'timeline.clearInOut', 'Clear In/Out'],
      ['app/timeline', 'nav', 'playback.prevEdit', 'Previous Edit Point'],
      ['app/timeline', 'nav', 'playback.nextEdit', 'Next Edit Point'],
      ['app/timeline', 'nav', 'keyframes.prev', 'Previous Keyframe'],
      ['app/timeline', 'nav', 'keyframes.next', 'Next Keyframe'],
      ['app/timeline', 'opts', 'timeline.snapping', 'Snapping', { checked: (a) => a.view.snapping.get() }],
      ['app/playback', 'transport', 'playback.toggle', 'Play / Pause'],
      ['app/playback', 'transport', 'playback.stepBack', 'Previous Frame'],
      ['app/playback', 'transport', 'playback.stepForward', 'Next Frame'],
      ['app/playback', 'jump', 'playback.start', 'Go to Start'],
      ['app/playback', 'jump', 'playback.end', 'Go to End'],
      ['app/playback', 'opts', 'playback.loop', 'Loop', { checked: (a) => a.playback.loop.get() }],
      ['app/view', 'zoom', 'timeline.zoomIn', 'Zoom In'],
      ['app/view', 'zoom', 'timeline.zoomOut', 'Zoom Out'],
      ['app/view', 'zoom', 'timeline.zoomFit', 'Zoom to Fit']
    ]
    menu.forEach(([location, group, command, label, extra], order) =>
      ctx.menus.register({ id: `menu:${command}`, location, group, command, label, order: order * 10, ...extra }))
  }
})

function jumpEdit(a: CascadeAPI, dir: -1 | 1) {
  const now = a.playback.time.get()
  let best: number | null = null
  for (const tr of a.timeline().tracks)
    for (const c of tr.clips)
      for (const t of [c.start, clipEnd(c)]) {
        if (dir > 0 && t > now && (best === null || t < best)) best = t
        if (dir < 0 && t < now && (best === null || t > best)) best = t
      }
  if (best !== null) {
    a.playback.pause()
    a.playback.seek(best)
  }
}

function trimToPlayhead(a: CascadeAPI, edge: 'start' | 'end') {
  const t = a.playback.time.get()
  const tl = a.timeline()
  const ids = sel(a).length
    ? sel(a)
    : tl.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.start < t && clipEnd(c) > t).map((c) => c.id))
  for (const id of ids) {
    const f = findClip(tl, id)
    if (f && f.clip.start < t && clipEnd(f.clip) > t) a.edit.trimClip(id, edge, t, { linked: true, ...rippleOptions(a) })
  }
}
