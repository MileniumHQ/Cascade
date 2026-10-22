import type { PluginContext, TimelineToolContribution, TimelineToolContext, TimelineToolHit } from '@core/plugin-api'
import type { GestureOpts } from '@core/editing'
import { clipEnd, findClip } from '@shared/project'
import { formatTimecode, snapToFrame } from '@shared/time'
import { expandLinked } from '@core/timeline-ops'
import type { Disposable } from '@core/disposable'
import { linkedSelection } from './state'

/** Live operations use incremental deltas; edge targets remain anchored to the original cut. */
function trimDrag(tool: 'ripple' | 'roll' | 'slip' | 'slide', e: PointerEvent, ctx: TimelineToolContext, hit: TimelineToolHit) {
  if (!hit.clipId) return
  const app = ctx.app
  const f = findClip(app.timeline(), hit.clipId)
  if (!f || f.track.locked) return
  const id = hit.clipId
  const edge = hit.edge ?? (Math.abs(ctx.timeAt(e.clientX) - f.clip.start) < Math.abs(ctx.timeAt(e.clientX) - clipEnd(f.clip)) ? 'start' : 'end')
  const original = edge === 'start' ? f.clip.start : clipEnd(f.clip)
  const anchor = ctx.timeAt(e.clientX)
  const linked = linkedSelection.get() && !e.altKey
  const exclude = expandLinked(app.timeline(), [id])
  let phase: GestureOpts['gesture'] = 'start'
  let applied = 0
  let cleaned = false
  const measure = () => {
    const c = findClip(app.timeline(), id)?.clip
    if (!c) return applied
    if (tool === 'slide') return c.start - f.clip.start
    if (tool === 'slip') return Math.round(app.edit.timeMap(f.clip).localAt(c.sourceIn - f.clip.sourceIn))
    if (tool === 'ripple' && edge === 'start') return f.clip.duration - c.duration
    return (edge === 'start' ? c.start : clipEnd(c)) - original
  }
  const move = (ev: PointerEvent) => {
    const raw = original + ctx.timeAt(ev.clientX) - anchor
    const desired = tool === 'slip' || tool === 'slide' ? snapToFrame(raw, app.fps()) - original : ctx.snap(raw, exclude, ev.altKey) - original
    const opts = { gesture: phase, linked }
    const current = findClip(app.timeline(), id)?.clip
    if (!current) return cleanup()
    if (tool === 'ripple') {
      const base = edge === 'start' ? current.start : clipEnd(current)
      app.edit.rippleTrim(id, edge, base + desired - applied, opts)
    } else if (tool === 'roll') app.edit.rollEdit(id, edge, desired - applied, opts)
    else if (tool === 'slip') {
      const map = app.edit.timeMap(f.clip)
      const sourceDelta = map.offset(desired) - (current.sourceIn - f.clip.sourceIn)
      const delta = map.localAt(sourceDelta)
      if (Number.isFinite(delta)) app.edit.slipClip(id, delta, opts)
    } else app.edit.slideClip(id, desired - applied, opts)
    phase = 'update'
    applied = measure()
    const delta = `${applied < 0 ? '−' : '+'}${formatTimecode(Math.abs(applied), app.fps())}`
    const c = findClip(app.timeline(), id)?.clip
    ctx.feedback(tool === 'slip' && c ? `${delta} · ${formatTimecode(c.sourceIn, app.fps())} → ${formatTimecode(c.sourceIn + app.edit.timeMap(c).offset(c.duration), app.fps())}` : delta, ev)
  }
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cleanup)
    if (phase !== 'start') app.doc.endGesture()
    ctx.feedback(null)
  }
  const up = (ev: PointerEvent) => { if (phase !== 'start') move(ev); cleanup() }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cleanup)
  return cleanup
}

export function registerTimelineTools(ctx: PluginContext) {
  const tools: TimelineToolContribution[] = [
    { id: 'select', name: 'Select', icon: 'mouse-pointer-2', key: 'V', cursor: 'default', pointerDown(e, c) {
      const hit = c.hitTest(e.clientX, e.clientY)
      if (!hit?.clipId) return
      c.selectClip(hit.clipId, e)
      // Shift at an edge requests ripple; Alt continues to disable snapping/linked selection.
      if (hit.edge && (e.shiftKey || c.app.settings.get<boolean>('timeline.rippleMode'))) return trimDrag('ripple', e, c, hit)
      if (hit.edge) return c.trimClip(e, hit.clipId, hit.edge)
      return c.moveClip(e, hit.clipId)
    } },
    { id: 'blade', name: 'Blade', icon: 'scissors', key: 'C', cursor: 'crosshair', pointerDown(e, c) {
      const hit = c.hitTest(e.clientX, e.clientY)
      c.app.edit.splitAt(c.snap(c.timeAt(e.clientX), new Set(), e.altKey), hit?.clipId ? [hit.clipId] : undefined)
    } },
    ...(['ripple', 'roll', 'slip', 'slide'] as const).map((id, i): TimelineToolContribution => ({
      id, name: ['Ripple', 'Roll', 'Slip', 'Slide'][i], icon: ['ripple-trim', 'roll-trim', 'arrow-left-right', 'move'][i], key: ['B', 'R', 'Y', 'U'][i], cursor: ['ew-resize', 'col-resize', 'grab', 'move'][i],
      pointerDown(e, c) {
        const hit = c.hitTest(e.clientX, e.clientY)
        if (!hit?.clipId) return
        c.selectClip(hit.clipId, e)
        return trimDrag(id, e, c, hit)
      }
    }))
  ]
  for (const [i, tool] of tools.entries()) ctx.timelineTools.register({ priority: i * 10, ...tool })
  const registrations = new Map<string, Disposable[]>()
  const sync = () => {
    for (const ds of registrations.values()) ds.forEach((d) => d.dispose())
    registrations.clear()
    for (const t of ctx.app.registries.timelineTools.all()) {
      const command = `timeline.tool.${t.id}`
      const ds = [ctx.commands.register({ id: command, title: `${t.name} tool`, category: 'Timeline', run: (a) => a.view.tool.set(t.id) }),
        ctx.menus.register({ id: `tool:${t.id}`, command, location: 'app/timeline', group: 'tools', label: `${t.name} tool`, order: t.priority, shortcut: t.key, checked: (a) => a.view.tool.get() === t.id })]
      if (t.key) ds.push(ctx.keybindings.register({ id: `tool:${t.id}`, command, key: t.key }))
      registrations.set(t.id, ds)
    }
    if (!ctx.app.registries.timelineTools.has(ctx.app.view.tool.get())) ctx.app.view.tool.set('select')
  }
  sync()
  ctx.track(ctx.app.registries.timelineTools.onChange.on(sync))
  ctx.track({ dispose() { for (const ds of registrations.values()) ds.forEach((d) => d.dispose()) } })
  // Preserve the old select alias; B is now explicitly assigned to Ripple.
  ctx.keybindings.register({ id: 'timeline.tool.select:A', command: 'timeline.tool.select', key: 'A' })
}
