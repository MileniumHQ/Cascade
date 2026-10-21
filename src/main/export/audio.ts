import { open, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClipAudioPlan, ExportRequest, RenderWorkerJob } from '../../shared/ipc'
import { FLICKS } from '../../shared/time'
import { ExportScope } from './process'

/** Quote a path for an ffmpeg filtergraph option value. */
const filterPath = (p: string) => `'${p.replace(/\\/g, '\\\\').replace(/'/g, `'\\''`)}'`

export async function renderAudio(scope: ExportScope, ffmpeg: string, req: ExportRequest, directory: string, duration: number, progress: (message: string) => void): Promise<string> {
  const sampleRate = req.project.settings.sampleRate
  const sources: NonNullable<RenderWorkerJob['pcmSources']> = {}
  const ranges = new Map<string, { start: number; end: number; path: string }>()
  const stretch: [string, ClipAudioPlan][] = []
  const add = (mediaId: string, start: number, stop: number) => {
    const media = req.project.media[mediaId]
    if (!media?.path) return
    const range = ranges.get(mediaId)
    if (range) { range.start = Math.min(range.start, start); range.end = Math.max(range.end, stop) }
    else ranges.set(mediaId, { start, end: stop, path: media.path })
  }
  if (req.audio) {
    for (const [clipId, plan] of Object.entries(req.audio)) {
      if (plan.mode === 'stretch') stretch.push([clipId, plan])
      else add(plan.mediaId, plan.sourceStart, plan.sourceEnd)
    }
  } else {
    // Requests without an audio plan: constant clip speed, resampled.
    const end = req.range.start / FLICKS + duration
    for (const track of req.project.timelines[req.timelineId].tracks) {
      if (track.muted) continue
      for (const clip of track.clips) {
        const media = clip.mediaId ? req.project.media[clip.mediaId] : undefined
        if (!media?.path || media.meta.hasAudio === false) continue
        const from = Math.max(req.range.start / FLICKS, clip.start / FLICKS)
        const to = Math.min(end, (clip.start + clip.duration) / FLICKS)
        if (to <= from) continue
        const speed = clip.speed ?? 1
        if (!Number.isFinite(speed) || speed <= 0) throw new Error('Audio export requires positive clip speed')
        const start = Math.max(0, clip.sourceIn / FLICKS + (from - clip.start / FLICKS) * speed)
        add(media.id, start, Math.max(start, clip.sourceIn / FLICKS + (to - clip.start / FLICKS) * speed))
      }
    }
  }
  // Decode sequentially: do not compete with N video decoders using unbounded ffmpeg threads.
  for (const [id, range] of ranges) {
    scope.check()
    progress(`Decoding audio: ${req.project.media[id].name}`)
    const path = join(directory, `source-${Object.keys(sources).length}.f32`)
    // Output seeking preserves codec priming. Input -ss (even zero) shifts Opus by a packet.
    await scope.run(ffmpeg, ['-threads', '2', '-i', range.path, ...(range.start > 0 ? ['-ss', String(range.start)] : []), '-t', String(range.end - range.start), '-vn', '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', path])
    sources[id] = { path, start: range.start, sampleRate, frames: (await stat(path)).size / 8 }
  }
  // Time-stretched clips: rubberband keeps pitch independent of speed; asendcmd follows speed curves.
  for (const [clipId, plan] of stretch) {
    scope.check()
    const media = req.project.media[plan.mediaId]
    if (!media?.path) continue
    progress(`Time-stretching audio: ${media.name}`)
    const n = Object.keys(sources).length
    const path = join(directory, `clip-${n}.f32`)
    const filters = [`atrim=start=${plan.sourceStart}:end=${plan.sourceEnd}`, 'asetpts=PTS-STARTPTS', ...(plan.reverse ? ['areverse'] : [])]
    if (plan.commands?.length) {
      const cmds = join(directory, `clip-${n}.cmd`)
      await writeFile(cmds, plan.commands.map((c) => `${c.t.toFixed(6)} rubberband tempo ${c.tempo.toFixed(6)}, rubberband pitch ${c.pitch.toFixed(6)};`).join('\n'))
      filters.push(`asendcmd=f=${filterPath(cmds)}`)
    }
    filters.push(`rubberband=tempo=${(plan.tempo ?? 1).toFixed(6)}:pitch=${(plan.pitch ?? 1).toFixed(6)}`)
    await scope.run(ffmpeg, ['-threads', '2', '-i', media.path, '-vn', '-af', filters.join(','), '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', path])
    sources[`clip:${clipId}`] = { path, start: plan.localStart ?? 0, sampleRate, frames: (await stat(path)).size / 8 }
  }
  const worker = scope.worker({ project: req.project, timelineId: req.timelineId, width: 8, height: 8, fps: req.fps, mode: 'audio', stampHeight: 0, pcmSources: sources })
  const path = join(directory, 'mix.f32')
  const output = await open(path, 'w')
  try {
    const total = Math.round(duration * sampleRate)
    const chunk = sampleRate * 10
    for (let offset = 0, index = 0; offset < total; offset += chunk, index++) {
      scope.check()
      const count = Math.min(chunk, total - offset)
      progress(`Mixing audio: ${Math.round(offset / total * 100)}%`)
      const pcm = await worker.renderAudio(index, req.range.start / FLICKS + offset / sampleRate, count / sampleRate)
      if (pcm.byteLength !== count * 8) throw new Error(`Audio chunk has ${pcm.byteLength} bytes, expected ${count * 8}`)
      await output.writeFile(Buffer.from(pcm))
    }
  } finally { await output.close(); scope.closeWorker(worker) }
  return path
}
