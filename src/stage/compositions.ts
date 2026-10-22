/** A reusable composition service for arbitrary media plugins, shared by preview/export. */
import type { ClipFrameState, StageAudio, SubComposition } from '@core/plugin-api'
import { sourceLocalRange } from '@core/time-remap'
import { timelineDuration, type Id, type Project } from '@shared/project'
import { FLICKS } from '@shared/time'
import { Stage, type StageOptions } from './stage'
import { resampleComposition } from './composition-audio'

export function mountComposition(opts: StageOptions, ancestors: readonly Id[], id: Id, container: HTMLElement): SubComposition {
  if (ancestors.includes(id) || ancestors.length >= 64) {
    console.warn(`[stage] recursive composition skipped: ${[...ancestors, id].join(' → ')}`)
    return { update() {}, async prepare() {}, dispose() {} }
  }
  const out = opts.audio?.context.createGain()
  const childAudio: StageAudio | undefined = opts.audio && !opts.audio.chunk ? { ...opts.audio, destination: out! } : undefined
  const child = new Stage({ ...opts, audio: childAudio, container, transparent: true, ancestors })
  let scheduled: AudioBufferSourceNode | undefined
  let prepared = false, disposed = false
  let previewNode: AudioBufferSourceNode | undefined
  let generation = 0, pending = false
  let anchor: { at: number; local: number; duration: number; transport: number; project: Project } | undefined
  let requested: typeof anchor
  const stopPreview = () => {
    generation++
    anchor = undefined
    requested = undefined
    try { previewNode?.stop(); previewNode?.disconnect() } catch {}
    previewNode = undefined
  }
  const mix = async (project: Project, start: number, end: number): Promise<AudioBuffer> => {
    const audio = opts.audio!, rate = audio.context.sampleRate
    const context = new OfflineAudioContext(2, Math.max(1, Math.ceil((end - start) * rate)), rate)
    const nestedAudio: StageAudio = { ...audio, context, destination: context.destination, chunk: { start, duration: end - start } }
    const nested = new Stage({ ...opts, mode: 'render', container: opts.document.createElement('div'), audio: nestedAudio, ancestors })
    try {
      await nested.renderAudioChunk(project, id, Math.round(start * FLICKS), Math.round((end - start) * FLICKS))
      return await context.startRendering()
    } finally { nested.dispose() }
  }
  const preview = (s: ClipFrameState) => {
    const audio = opts.audio
    if (!audio || !out || audio.chunk || disposed || !s.project.timelines[id]) return
    const speed = s.remap.speedAt(s.local) * (s.remap.reversed ? -1 : 1)
    if (!speed || !s.rate) { stopPreview(); return }
    const transport = s.rate / speed, now = audio.context.currentTime
    if (pending) {
      if (requested) {
        const expected = requested.local + (now - requested.at) * FLICKS * requested.transport
        if (requested.project !== s.project || requested.transport !== transport || Math.abs(expected - s.local) > FLICKS * .15) stopPreview()
      }
      return
    }
    if (anchor) {
      const expected = anchor.local + (now - anchor.at) * FLICKS * anchor.transport
      const stable = anchor.project === s.project && anchor.transport === transport && Math.abs(expected - s.local) < FLICKS * .15
      if (stable && now - anchor.at < anchor.duration - .35) return
      if (!stable) stopPreview()
    }
    const available = sourceLocalRange(s.clip, s.remap, timelineDuration(s.project.timelines[id]))
    const localEnd = Math.min((s.activeRange?.end ?? s.clip.start + s.clip.duration) - s.clip.start, available.end), localStart = Math.max((s.activeRange?.start ?? s.clip.start) - s.clip.start, available.start)
    const duration = Math.min(2, (transport > 0 ? localEnd - s.local : s.local - localStart) / FLICKS / Math.abs(transport))
    if (duration <= 0) { stopPreview(); return }
    const a = s.clip.sourceIn + s.remap.offset(s.local), b = s.clip.sourceIn + s.remap.offset(s.local + duration * FLICKS * transport)
    const sampleRate = audio.context.sampleRate
    const start = Math.max(0, Math.floor(Math.min(a, b) / FLICKS * sampleRate) / sampleRate)
    const end = Math.max(a, b) / FLICKS + 2 / sampleRate
    if (end <= start) return
    const token = generation
    pending = true
    requested = { at: now, local: s.local, duration, transport, project: s.project }
    void mix(s.project, start, end).then(buffer => {
      if (disposed || token !== generation) return
      const elapsed = audio.context.currentTime - now
      if (elapsed >= duration) return
      const frames = Math.max(1, Math.ceil(duration * sampleRate))
      const data = resampleComposition([buffer.getChannelData(0), buffer.getChannelData(1)], sampleRate,
        Math.round(start * FLICKS), sampleRate, frames, s.clip.sourceIn, s.local, s.remap, transport)
      const output = audio.context.createBuffer(2, frames, sampleRate)
      data.forEach((channel, i) => output.getChannelData(i).set(channel))
      const node = audio.context.createBufferSource()
      node.buffer = output
      node.connect(out)
      try { previewNode?.stop(); previewNode?.disconnect() } catch {}
      previewNode = node
      node.start(0, Math.max(0, elapsed))
      anchor = { at: now, local: s.local, duration, transport, project: s.project }
    }).catch(e => console.warn('[stage] composition audio unavailable', e)).finally(() => { pending = false; requested = undefined })
  }
  const time = (s: ClipFrameState) => Math.round(s.sourceTime * FLICKS)
  return {
    audioOut: out,
    update(s) {
      const retimed = s.remap.constant !== 1 || s.remap.reversed || s.rate !== 1
      if (!s.audioOnly) child.render(s.project, id, time(s), { playing: s.playing && !retimed, rate: s.rate })
      if (s.playing && retimed) preview(s)
      else if (anchor || pending) stopPreview()
    },
    async prepare(s) {
      if (!s.audioOnly) await child.renderExact(s.project, id, time(s))
      const audio = opts.audio
      if (!audio?.chunk || !out || prepared || disposed || !s.project.timelines[id]) return
      prepared = true
      const available = sourceLocalRange(s.clip, s.remap, timelineDuration(s.project.timelines[id]))
      const from = Math.max(Math.round(audio.chunk.start * FLICKS), s.activeRange?.start ?? s.clip.start, s.clip.start + available.start)
      const to = Math.min(Math.round((audio.chunk.start + audio.chunk.duration) * FLICKS), s.activeRange?.end ?? s.clip.start + s.clip.duration, s.clip.start + available.end)
      if (to <= from || s.remap.max === 0) return
      const a = s.clip.sourceIn + s.remap.offset(from - s.clip.start)
      const b = s.clip.sourceIn + s.remap.offset(to - s.clip.start)
      if (a === b) return
      const rate = audio.context.sampleRate
      const start = Math.max(0, Math.floor(Math.min(a, b) / FLICKS * rate) / rate)
      const end = Math.max(a, b) / FLICKS + 2 / rate
      const buffer = await mix(s.project, start, end)
      if (disposed) return
      const frames = Math.max(1, Math.ceil((to - from) / FLICKS * rate))
      const data = resampleComposition([buffer.getChannelData(0), buffer.getChannelData(1)], rate,
        Math.round(start * FLICKS), rate, frames, s.clip.sourceIn, from - s.clip.start, s.remap)
      const output = audio.context.createBuffer(2, frames, rate)
      data.forEach((channel, i) => output.getChannelData(i).set(channel))
      scheduled = audio.context.createBufferSource()
      scheduled.buffer = output
      scheduled.connect(out)
      scheduled.start(Math.max(0, from / FLICKS - audio.chunk.start))
    },
    dispose() {
      disposed = true
      stopPreview()
      try { scheduled?.stop(); scheduled?.disconnect(); out?.disconnect() } catch {}
      child.dispose()
    }
  }
}
