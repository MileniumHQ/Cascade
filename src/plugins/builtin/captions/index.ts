import { definePlugin } from '@core/plugin-api'
import { Value } from '@core/value'
import { findClip, uid, type Clip, type Id, type MediaItem, type PropertyInstance } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { TranscribeProgress } from '@shared/ipc'
import { pushToast } from '@ui/kit'
import { constantMap } from '@core/time-remap'
import { groupCaptions } from './group'
import { mountCaptionProgress } from './progress'

export interface GenerateCaptionsOptions {
  clipId?: Id; mediaId?: Id; language?: string
  /** Existing visual track to put the captions on (replacing what it holds in their range) instead of a new track. */
  trackId?: Id
  /** Parameter overrides by property type (transform, size, text, shadow) for every caption. */
  style?: Record<string, Record<string, unknown>>
  /** With trackId: clear what the track holds in the captioned range first (default true). */
  replace?: boolean
}
export interface CaptionsService {
  generate(opts?: GenerateCaptionsOptions): Promise<Id[]>
  cancel(): Promise<void>
}
const supported = (media?: MediaItem) => !!media?.path && (media.type === 'audio' || media.type === 'video') && media.meta.hasAudio !== false
const property = (type: string, values: Record<string, unknown>): PropertyInstance => ({ id: uid('pi_'), type, enabled: true,
  params: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])) })

/** A caption text clip in the default caption look; `style` overrides parameters by property type. */
export function captionClip(text: string, start: Flicks, end: Flicks, style?: Record<string, Record<string, unknown>>, data: Record<string, unknown> = {}): Clip {
  const styled = (type: string, values: Record<string, unknown>) => property(type, { ...values, ...style?.[type] })
  return { id: uid('cl_'), type: 'element', name: text.replace(/\n/g, ' '),
    start, duration: end - start, sourceIn: 0, data: { kind: 'text', ...data },
    properties: [
      styled('transform', { position: [0, 0.34], scale: 1, rotation: 0, anchor: [0.5, 0.5] }),
      styled('size', { size: [0.88, 0.16], padding: 0 }),
      styled('text', { font: 'Inter', size: 0.046, weight: 750, color: '#ffffff', align: 'center', italic: false, tracking: 0, leading: 1.2, stroke: 0.006, strokeColor: '#111111', text }),
      // Soft shadow keeps captions legible over bright footage.
      styled('shadow', { offset: [0, 0.002], blur: 0.006, color: '#000000cc' })
    ] }
}

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
          const clips = captions.map((c) => captionClip(c.text, c.start, c.end, opts.style, { caption: { mediaId: media.id, model: transcript.model, language: transcript.language } }))
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
    ctx.commands.register({ id: 'captions.cancel', title: 'Cancel caption generation', category: 'Captions', enabled: () => busy, run: () => service.cancel() })
    ctx.menus.register({ id: 'captions.clip', location: 'clip/context', label: 'Generate captions', icon: 'captions', command: 'captions.generate',
      when: (_app, target) => { const clip = typeof target === 'string' && findClip(app.timeline(), target)?.clip; return !!clip && ['video', 'audio'].includes(clip.type) && supported(projectMedia(clip.mediaId)) } })
    const projectMedia = (id?: string) => id ? app.project().media[id] : undefined
    ctx.menus.register({ id: 'captions.source', location: 'source/context', label: 'Generate captions', icon: 'captions', command: 'captions.generate', when: (_app, target) => supported(target as MediaItem) })
    ctx.statusItems.register({ id: 'captions.progress', align: 'right', order: 40, mount: (el) => mountCaptionProgress(el, progress, service.cancel) })
  }
})
