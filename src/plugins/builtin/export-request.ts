import type { CascadeAPI } from '@core/app'
import type { ClipAudioPlan, ExportRequest } from '@shared/ipc'
import { clipEnd } from '@shared/project'
import { FLICKS, type Flicks, type FrameRate } from '@shared/time'
import { pitchOf } from './properties/audio'

export interface ExportJobSpec {
  exporter: string
  output: string
  /** Partial option values; missing ones take the exporter's defaults. */
  options?: Record<string, unknown>
  width?: number
  height?: number
  fps?: FrameRate
  range?: { start: Flicks; end: Flicks }
}

/** True if any audible audio clip overlaps the range (decides whether formats get an audio stream). */
export function rangeHasAudio(app: CascadeAPI, range: { start: Flicks; end: Flicks }): boolean {
  const tl = app.project().timelines[app.project().activeTimeline]
  return !!tl?.tracks.some((t) => t.kind === 'audio' && !t.muted && t.clips.some((c) => c.start < range.end && clipEnd(c) > range.start))
}

/** Max rubberband commands per clip for a varying speed (a 10 Hz control rate, capped). */
const MAX_COMMANDS = 400

/**
 * Audio processing for every audible clip in the range. Unchanged or "match speed" clips are
 * resampled by the render worker; others (and reversed clips) are time-stretched by ffmpeg so
 * pitch matches the preview (where the media element preserves pitch).
 */
export function audioPlan(app: CascadeAPI, range: { start: Flicks; end: Flicks }): Record<string, ClipAudioPlan> {
  const project = app.project()
  const tl = project.timelines[project.activeTimeline]
  const plan: Record<string, ClipAudioPlan> = {}
  for (const track of tl?.tracks ?? []) {
    // Sound comes from audio tracks only (a video's picture clip is muted).
    if (track.muted || track.kind !== 'audio') continue
    for (const clip of track.clips) {
      const media = clip.mediaId ? project.media[clip.mediaId] : undefined
      if (!media?.path || media.meta.hasAudio === false) continue
      const from = Math.max(range.start, clip.start) - clip.start
      const to = Math.min(range.end, clipEnd(clip)) - clip.start
      if (to <= from) continue
      const map = app.edit.timeMap(clip)
      const { semitones, matchSpeed } = pitchOf(clip)
      const o0 = map.offset(from)
      // A reversed clip covers the same source range, read from its end down.
      const a = (clip.sourceIn + o0) / FLICKS, b = (clip.sourceIn + map.offset(to)) / FLICKS
      const sourceStart = Math.max(0, Math.min(a, b))
      const sourceEnd = Math.max(sourceStart, a, b)
      const base = { mediaId: media.id, sourceStart, sourceEnd }
      if (!map.reversed && semitones === 0 && (matchSpeed || map.constant === 1)) {
        plan[clip.id] = { mode: 'source', ...base }
        continue
      }
      const shift = Math.pow(2, semitones / 12)
      const at = (t: Flicks) => {
        const tempo = map.speedAt(t)
        return { tempo, pitch: (matchSpeed ? tempo : 1) * shift }
      }
      const commands: NonNullable<ClipAudioPlan['commands']> = []
      if (map.constant === null) {
        const n = Math.min(MAX_COMMANDS, Math.max(2, Math.ceil(((to - from) / FLICKS) * 10)))
        for (let i = 1; i < n; i++) {
          const t = from + ((to - from) * i) / n
          commands.push({ t: Math.abs(map.offset(t) - o0) / FLICKS, ...at(t) })
        }
      }
      plan[clip.id] = { mode: 'stretch', ...base, localStart: from / FLICKS, ...at(from), commands, ...(map.reversed ? { reverse: true } : {}) }
    }
  }
  return plan
}

/** Resolve an export spec into a full ExportRequest: option defaults, global settings and the exporter's ffmpeg plan. */
export async function prepareExportRequest(app: CascadeAPI, spec: ExportJobSpec): Promise<ExportRequest> {
  const exporter = app.registries.exporters.get(spec.exporter)
  if (!exporter) throw new Error(`Unknown exporter ${spec.exporter}`)
  const s = app.project().settings
  const width = spec.width ?? s.width
  const height = spec.height ?? s.height
  const fps = spec.fps ?? s.fps
  const range = spec.range ?? { start: 0, end: app.duration() }
  const options: Record<string, unknown> = Object.fromEntries(exporter.options.map((p) => [p.id, p.default]))
  Object.assign(options, spec.options)
  if (app.settings.get<boolean>('export.hardware') === false && 'hardware' in options) options.hardware = false
  const info = await app.host!.info()
  const encoding = exporter.ffmpeg(options, { width, height, fps, hasAudio: exporter.audio && rangeHasAudio(app, range), hwEncoders: info.ffmpeg.hwEncoders })
  return {
    project: app.project(),
    timelineId: app.project().activeTimeline,
    width,
    height,
    fps,
    range,
    output: spec.output,
    exporter: exporter.id,
    options,
    encoding,
    workers: app.settings.get<number>('export.workers') ?? 0,
    audio: audioPlan(app, range)
  }
}
