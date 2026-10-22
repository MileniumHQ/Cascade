import { definePlugin } from '@core/plugin-api'
import { Value } from '@core/value'
import { findClip, uid, type Clip, type Id, type MediaItem, type PropertyInstance } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { TranscribeProgress } from '@shared/ipc'
import { pushToast } from '@ui/kit'
import { constantMap } from '@core/time-remap'
import type { PropertyStyle } from '@core/property-style'
import { openMenu, type MenuItem } from '@ui/kit'
import { builtinCaptionStyles, CAPTION_STYLE_KIND, CAPTION_STYLE_SETTING, captionStyles, currentCaptionStyle, styleOverBase } from './styles'
import { captionClip } from './clip'
import { groupCaptions } from './group'
import { mountCaptionProgress } from './progress'

export interface GenerateCaptionsOptions {
  clipId?: Id; mediaId?: Id; language?: string
  /** Existing visual track to put the captions on (replacing what it holds in their range) instead of a new track. */
  trackId?: Id
  /** Parameter overrides by property type (transform, size, text, shadow…) for every caption; `null` drops a base property. Defaults to the chosen caption style. */
  style?: PropertyStyle
  /** With trackId: clear what the track holds in the captioned range first (default true). */
  replace?: boolean
}
export { captionClip }
export interface CaptionsService {
  generate(opts?: GenerateCaptionsOptions): Promise<Id[]>
  cancel(): Promise<void>
}
const supported = (media?: MediaItem) => !!media?.path && (media.type === 'audio' || media.type === 'video') && media.meta.hasAudio !== false
export const captionsPlugin = definePlugin({
  id: 'cascade.captions', name: 'Captions',
  dependsOn: ['cascade.media.element', 'cascade.properties.text', 'cascade.properties.visual'],
  activate(ctx) {
    if (ctx.env !== 'editor') return
    const { app } = ctx
    const progress = new Value<TranscribeProgress | null>(null)
    let busy = false
    let disposed = false
    let cancelled = false
    let toastId = 100000
    const toast = (kind: 'info' | 'success' | 'error', message: string, detail?: string) => pushToast({ id: ++toastId, kind, message, detail })
    const service: CaptionsService = {
      cancel: async () => { cancelled = true; await app.host?.transcribe.cancel() },
      async generate(opts = {}) {
        if (busy) throw new Error('Caption generation is already running')
        const host = app.host
        if (!host) throw new Error('Local captioning requires the desktop app')
        const project = app.project(), timelineId = project.activeTimeline
        const clipId = opts.clipId ?? (!opts.mediaId ? app.selection.primaryClip : null)
        const clip = clipId ? findClip(app.timeline(), clipId)?.clip : undefined
        if (clipId && !clip) throw new Error('The caption target clip no longer exists')
        const media = project.media[opts.mediaId ?? clip?.mediaId ?? app.selection.media.get().at(-1) ?? '']
        if (!supported(media) || (clip && !['video', 'audio'].includes(clip.type))) throw new Error('Select a video or audio clip, or an audio source, to generate captions')
        const speed = clip ? app.edit.timeMap(clip) : constantMap(1)
        const sourceIn = clip?.sourceIn ?? 0
        const sourceEnd = clip ? Math.round(sourceIn + speed.offset(clip.duration)) : media.meta.duration
        if (!sourceEnd || sourceEnd <= sourceIn) throw new Error('The source has no usable duration')
        const usableTrack = () => {
          const tr = opts.trackId ? app.timeline().tracks.find((t) => t.id === opts.trackId) : undefined
          if (opts.trackId && (!tr || tr.kind !== 'visual' || tr.locked)) throw new Error('The captions track must be an unlocked visual track')
          return tr
        }
        usableTrack()
        const mapping = { sourceIn, start: clip?.start ?? app.playback.time.get(), speed, end: 0 }
        mapping.end = mapping.start + (clip?.duration ?? sourceEnd)
        busy = true
        cancelled = false
        const checkCancelled = () => { if (cancelled || disposed) throw new Error('Captioning cancelled') }
        let lastToast = 0
        const off = host.transcribe.onProgress((p) => {
          progress.set(p)
          if (Date.now() - lastToast > 15000 && !['done', 'cancelled', 'error'].includes(p.phase)) {
            lastToast = Date.now(); toast('info', p.message, p.phase === 'download' ? `${Math.round(p.progress * 100)}% · model stays on this computer` : undefined)
          }
        })
        try {
          const status = await host.transcribe.status()
          checkCancelled()
          if (!status.binary) throw new Error('Run bun run setup:whisper in the Cascade folder to build local captioning')
          const missing = status.models.filter((m) => !m.installed)
          if (missing.length) {
            const total = missing.reduce((n, m) => n + m.sizeBytes, 0)
            const answer = await host.dialog.confirm({ message: 'Download local caption models?',
              detail: `${Math.ceil(total / 1e6)} MB. Whisper Large v3 Turbo and Silero VAD run on this computer. Your audio stays local.`, buttons: ['Download models', 'Cancel'] })
            checkCancelled()
            if (answer !== 0) return []
            for (const model of missing) { await host.transcribe.installModel(model.id); checkCancelled() }
          }
          const transcript = await host.transcribe.run(media.path!, { range: { start: sourceIn, end: sourceEnd }, language: opts.language })
          checkCancelled()
          // Long-running work must never insert into a different project/timeline or a changed clip.
          const current = app.project()
          const currentTimeline = current.timelines[timelineId]
          const now = clip && currentTimeline && findClip(currentTimeline, clip.id)?.clip
          if (current.id !== project.id || current.activeTimeline !== timelineId || current.media[media.id]?.path !== media.path || (clip && (!now || now.start !== clip.start || now.duration !== clip.duration || now.sourceIn !== clip.sourceIn || Math.round(app.edit.timeMap(now).offset(now.duration)) !== sourceEnd - sourceIn || now.mediaId !== clip.mediaId))) {
            throw new Error('The caption target changed. Select it and generate again (the transcript is cached).')
          }
          const captions = groupCaptions(transcript, mapping)
          if (!captions.length) { toast('info', 'No speech found in this range'); return [] }
          const clips = captions.map((c) => captionClip(c.text, c.start, c.end, opts.style ?? currentCaptionStyle(app)?.value, { caption: { mediaId: media.id, model: transcript.model, language: transcript.language } }))
          const target = usableTrack()
          if (target) app.edit.placeClips(target.id, clips, { label: 'Generate captions', replace: opts.replace === false ? undefined : [mapping.start, mapping.end] })
          else app.edit.addTrack('visual', { name: 'Captions', clips, label: 'Generate captions' })
          app.selection.setClips([clips[0].id])
          app.layout.reveal('timeline')
          toast('success', `Created ${clips.length} captions`, 'Editable text clips · undo in one step')
          return clips.map((c) => c.id)
        } finally { off(); busy = false; progress.set(null) }
      }
    }
    const run = async (target?: string | GenerateCaptionsOptions) => {
      const opts = typeof target === 'string' ? (findClip(app.timeline(), target) ? { clipId: target } : { mediaId: target }) : target
      try { return await service.generate(opts) } catch (error) { toast('error', 'Could not generate captions', error instanceof Error ? error.message : String(error)); return [] }
    }
    app.services.set('captions', service)
    ctx.track({ dispose() { disposed = true; if (busy) void service.cancel(); if (app.services.get('captions') === service) app.services.delete('captions') } })
    ctx.commands.register({ id: 'captions.generate', title: 'Generate captions', icon: 'captions', category: 'Captions', run: (_app, target) => run(target) })
    // Caption styles are presets of kind CAPTION_STYLE_KIND: other plugins add looks with ctx.presets.register.
    builtinCaptionStyles.forEach((style, i) => ctx.presets.register({ ...style, id: `${CAPTION_STYLE_KIND}:${style.id}`, kind: CAPTION_STYLE_KIND, priority: 500 + i }))
    let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 3 }
    const trackPointer = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY } }
    window.addEventListener('pointerdown', trackPointer, true)
    ctx.track({ dispose: () => window.removeEventListener('pointerdown', trackPointer, true) })
    const styleItems = (checked: (id: string) => boolean, pick: (id: string) => void): MenuItem[] =>
      captionStyles(app).map((style) => ({ label: style.name, icon: style.icon ?? 'captions', checked: checked(style.id), run: () => pick(style.id) }))
    /** Selected clips a style can be applied to: caption clips, else any selected clip with a text property. */
    const restyleTargets = () => {
      const clips = app.selection.clips.get().map((id) => findClip(app.timeline(), id)?.clip).filter((c): c is Clip => !!c)
      const captionsOnly = clips.filter((c) => c.data.caption || c.data.script)
      return (captionsOnly.length ? captionsOnly : clips.filter((c) => c.properties.some((p) => p.type === 'text'))).map((c) => c.id)
    }
    const restyle = (styleId: string) => {
      const style = captionStyles(app).find((p) => p.id === styleId)
      const targets = restyleTargets()
      if (!style || !targets.length) return 0
      const count = app.edit.applyStyle(targets, styleOverBase(style.value), `Caption style: ${style.name}`)
      toast('success', `Restyled ${count} caption${count === 1 ? '' : 's'}`, style.name)
      return count
    }
    ctx.commands.register({ id: 'captions.style', title: 'Caption style…', icon: 'captions', category: 'Captions',
      run: (_app, styleId) => {
        if (typeof styleId === 'string') { app.settings.set(CAPTION_STYLE_SETTING, styleId); return styleId }
        const current = currentCaptionStyle(app)?.id
        openMenu(pointer, styleItems((id) => id === current, (id) => app.settings.set(CAPTION_STYLE_SETTING, id)))
      } })
    ctx.commands.register({ id: 'captions.restyle', title: 'Restyle selected captions…', icon: 'palette', category: 'Captions',
      enabled: () => restyleTargets().length > 0,
      run: (_app, styleId) => {
        if (typeof styleId === 'string') return restyle(styleId)
        openMenu(pointer, styleItems(() => false, restyle))
      } })
    ctx.menus.register({ id: 'captions.styleMenu', location: 'app/timeline', group: 'captions', order: 50, label: 'Caption style…', icon: 'captions', command: 'captions.style' })
    ctx.menus.register({ id: 'captions.restyleMenu', location: 'app/timeline', group: 'captions', order: 51, label: 'Restyle selected captions…', icon: 'palette', command: 'captions.restyle' })
    ctx.menus.register({ id: 'captions.restyleClip', location: 'clip/context', label: 'Restyle captions…', icon: 'palette', command: 'captions.restyle',
      when: (_app, target) => { const clip = typeof target === 'string' ? findClip(app.timeline(), target)?.clip : undefined; return !!clip && !!(clip.data.caption || clip.data.script) } })
    ctx.menus.register({ id: 'captions.styleClip', location: 'clip/context', label: 'Caption style…', icon: 'captions', command: 'captions.style',
      when: (_app, target) => { const clip = typeof target === 'string' && findClip(app.timeline(), target)?.clip; return !!clip && ['video', 'audio'].includes(clip.type) && supported(projectMedia(clip.mediaId)) } })
    ctx.menus.register({ id: 'captions.styleSource', location: 'source/context', label: 'Caption style…', icon: 'captions', command: 'captions.style', when: (_app, target) => supported(target as MediaItem) })
    ctx.commands.register({ id: 'captions.cancel', title: 'Cancel caption generation', category: 'Captions', enabled: () => busy, run: () => service.cancel() })
    ctx.menus.register({ id: 'captions.clip', location: 'clip/context', label: 'Generate captions', icon: 'captions', command: 'captions.generate',
      when: (_app, target) => { const clip = typeof target === 'string' && findClip(app.timeline(), target)?.clip; return !!clip && ['video', 'audio'].includes(clip.type) && supported(projectMedia(clip.mediaId)) } })
    const projectMedia = (id?: string) => id ? app.project().media[id] : undefined
    ctx.menus.register({ id: 'captions.source', location: 'source/context', label: 'Generate captions', icon: 'captions', command: 'captions.generate', when: (_app, target) => supported(target as MediaItem) })
    ctx.statusItems.register({ id: 'captions.progress', align: 'right', order: 40, mount: (el) => mountCaptionProgress(el, progress, service.cancel) })
  }
})
