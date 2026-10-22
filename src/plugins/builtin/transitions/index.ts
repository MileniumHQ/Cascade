import { definePlugin } from '@core/plugin-api'
import { nearestTransitionEdge } from '@core/transitions'
import { findClip, type TrackKind } from '@shared/project'
import type { CascadeAPI } from '@core/app'
import { audioCrossfade, visualTransitions } from './effects'

function addDefault(app: CascadeAPI, kind: TrackKind, clipId?: string) {
  const tl = app.timeline(), selected = clipId ? [clipId] : app.selection.clips.get()
  const trackIds = new Set(selected.map(id => findClip(tl, id)?.track.id).filter(Boolean))
  if (!trackIds.size && app.selection.track.get()) trackIds.add(app.selection.track.get()!)
  let tracks = tl.tracks.filter(t => t.kind === kind && !t.locked && trackIds.has(t.id))
  // The audio command follows selected picture clips' links onto their audio tracks.
  if (!tracks.length && kind === 'audio') {
    const links = new Set(selected.map(id => findClip(tl, id)?.clip.linkId).filter(Boolean))
    tracks = tl.tracks.filter(t => t.kind === kind && !t.locked && t.clips.some(c => c.linkId && links.has(c.linkId)))
  }
  if (!tracks.length && !trackIds.size) tracks = tl.tracks.filter(t => t.kind === kind && !t.locked).slice(0, 1)
  const type = app.registries.transitions.all().find(t => t.kinds.includes(kind))
  if (!type) return
  const ids: string[] = []
  for (const track of tracks) {
    const edge = nearestTransitionEdge(track, app.playback.time.get(), true)
    if (edge) { const id = app.edit.addTransition({ type: type.id, from: edge.from, to: edge.to }); if (id) ids.push(id) }
  }
  if (ids.length) app.selection.setTransitions(ids)
}

export const transitionsPlugin = definePlugin({
  id: 'cascade.transitions', name: 'Transitions',
  activate(ctx) {
    for (const [index, transition] of [...visualTransitions, audioCrossfade].entries()) ctx.transitions.register({ priority: 400 + index, ...transition })
    if (ctx.env === 'render') return
    for (const [id, kind, title, key] of [
      ['transition.addDefault', 'visual', 'Add transition', 'Mod+T'],
      ['transition.addAudioDefault', 'audio', 'Add audio crossfade', 'Mod+Shift+T']
    ] as const) {
      ctx.commands.register({ id, title, category: 'Timeline', icon: 'layers', run: (app, clipId?: string) => addDefault(app, kind, clipId) })
      ctx.keybindings.register({ id: `${id}:key`, command: id, key })
      for (const location of ['app/timeline', 'clip/context'] as const) ctx.menus.register({ id: `${id}:${location}`, location, command: id, label: title, group: 'transitions', shortcut: key })
    }
  }
})
