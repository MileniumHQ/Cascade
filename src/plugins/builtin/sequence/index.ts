import { definePlugin, type Clip } from '@core/plugin-api'
import type { CascadeAPI } from '@core/app'
import { timelineDuration } from '@shared/project'

/** Sequence is a regular media plugin. All dependency and stage services are generic. */
export const sequencePlugin = definePlugin({
  id: 'cascade.media.sequence', name: 'Sequences',
  activate(ctx) {
    ctx.mediaTypes.register({
      id: 'sequence', name: 'Sequence', icon: 'layers', color: '#998ac3', track: 'visual', timeBased: true,
      sourceMeta: (media, project) => ({ ...media.meta, duration: media.timelineId && project.timelines[media.timelineId] ? timelineDuration(project.timelines[media.timelineId]) : 0,
        width: project.settings.width, height: project.settings.height, hasVideo: true }),
      hasAudio: ({ clip, media, range, remap, timelineHasAudio }) => {
        if (!media?.timelineId) return false
        const a = clip.sourceIn + remap.offset(range.start), b = clip.sourceIn + remap.offset(range.end)
        return timelineHasAudio(media.timelineId, { start: Math.round(Math.min(a, b)), end: Math.round(Math.max(a, b)) })
      },
      open: (app, clip) => openSequence(app, clip),
      stage: {
        mount(m) {
          const el = m.document.createElement('div')
          el.style.cssText = 'position:relative;width:100cqw;height:100cqh;overflow:hidden'
          const child = m.media?.timelineId && m.compositions?.mount(m.media.timelineId, el)
          return { el, audioOut: child ? child.audioOut : undefined,
            update: s => { if (child) child.update(s) },
            prepare: async s => { if (child) await child.prepare(s) },
            dispose: () => { if (child) child.dispose() }
          }
        }
      },
      clipBody(el) {
        el.style.cssText = 'position:absolute;inset:0;border-top:3px solid rgba(255,255,255,.2);background:repeating-linear-gradient(90deg,transparent 0 36px,rgba(255,255,255,.045) 36px 37px)'
      }
    })
    if (ctx.env !== 'editor') return
    const selected = (a: CascadeAPI) => a.selection.primaryClip
    ctx.commands.register({ id: 'sequence.nest', title: 'Nest clips', icon: 'layers', category: 'Timeline',
      enabled: a => !a.edit.nestClipsReason(a.selection.clips.get()),
      run: a => a.edit.nestClips(a.selection.clips.get(), { mediaType: 'sequence' }) })
    ctx.commands.register({ id: 'sequence.breakApart', title: 'Break apart sequence', icon: 'layers', category: 'Timeline',
      enabled: a => !!selected(a) && a.timeline().tracks.some(t => t.clips.some(c => c.id === selected(a) && c.type === 'sequence')) && !a.edit.breakApartClipReason(selected(a)!),
      run: a => selected(a) && a.edit.breakApartClip(selected(a)!) })
    ctx.commands.register({ id: 'sequence.open', title: 'Open sequence', icon: 'layers', category: 'Timeline',
      run: (a, id?: string) => { const clip = a.timeline().tracks.flatMap(t => t.clips).find(c => c.id === (id ?? selected(a))); if (clip) openSequence(a, clip) } })
    ctx.commands.register({ id: 'sequence.add', title: 'Add timeline as sequence', icon: 'plus', category: 'Timeline',
      run: (a, timelineId: string, start?: number, trackId?: string) => {
        return a.edit.addComposition(timelineId, 'sequence', { start, trackId })
      } })
    ctx.commands.register({ id: 'sequence.breakApartReason', title: 'Why break apart is unavailable', category: 'Timeline',
      run: a => { const id = selected(a); if (id) a.notify('info', a.edit.breakApartClipReason(id) ?? 'Ready to break apart') } })
    ctx.menus.register({ id: 'sequence.breakApartReason.menu', location: 'clip/context', label: 'Why break apart is unavailable…', command: 'sequence.breakApartReason',
      when: a => !!selected(a) && a.timeline().tracks.some(t => t.clips.some(c => c.id === selected(a) && c.type === 'sequence')) && !!a.edit.breakApartClipReason(selected(a)!) })
    ctx.keybindings.register({ id: 'sequence.nest.key', key: 'Mod+G', command: 'sequence.nest' })
    ctx.keybindings.register({ id: 'sequence.breakApart.key', key: 'Mod+Shift+G', command: 'sequence.breakApart' })
    for (const location of ['app/timeline', 'clip/context'] as const) {
      ctx.menus.register({ id: `sequence.nest.${location}`, location, label: 'Nest clips', command: 'sequence.nest', shortcut: 'Mod+G', group: 'sequences', order: 80 })
      ctx.menus.register({ id: `sequence.breakApart.${location}`, location, label: 'Break apart sequence', command: 'sequence.breakApart', shortcut: 'Mod+Shift+G', group: 'sequences', order: 81,
        when: a => !!selected(a) && a.timeline().tracks.some(t => t.clips.some(c => c.id === selected(a) && c.type === 'sequence')) })
    }
    ctx.menus.register({ id: 'sequence.open.menu', location: 'clip/context', label: 'Open sequence', command: 'sequence.open', group: 'sequences', order: 82,
      when: (a, id) => a.timeline().tracks.some(t => t.clips.some(c => c.id === id && c.type === 'sequence')) })
  }
})

function openSequence(app: CascadeAPI, clip: Clip): void {
  const id = clip.mediaId && app.project().media[clip.mediaId]?.timelineId
  if (id) { app.edit.setActiveTimeline(id, true); app.layout.reveal('timeline') }
}
