import type { CascadeAPI } from '@core/app'
import type { ClipAudioPlan, ClipAudioSegment, ExportRequest } from '@shared/ipc'
import { anySolo, trackAudible } from '@shared/audio-mix'
import { FLICKS, type Flicks, type FrameRate } from '@shared/time'
import { pitchOf } from './properties/audio'
import { transitionClipRange } from '@core/transitions'
import { clipTimeMap, sourceLocalRange, type TimeMap } from '@core/time-remap'
import { compositionAudioRanges, timelineHasAudio } from '@core/media-audio'

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
  return timelineHasAudio(app.project(), app.registries, app.project().activeTimeline, range)
}

/** Max rubberband commands per clip for a varying speed (a 10 Hz control rate, capped). */
const MAX_COMMANDS = 400
/** Rubberband's tempo floor; slower moments of a ramp towards a hold are clamped to it. */
const MIN_TEMPO = 0.01
const HOLD_STEP = FLICKS / 10
const sourceIn = (clip: { sourceIn: Flicks }, offset: Flicks) => (clip.sourceIn + offset) / FLICKS

/** Clip-local `[start, end]` runs of a speed curve where the source actually advances. */
function movingRuns(map: TimeMap, from: Flicks, to: Flicks): (readonly [Flicks, Flicks])[] {
  const held = (t: Flicks) => map.speedAt(t) <= 1e-6
  // Find the instant a state change happens inside one cell, to flick precision.
  const edge = (lo: Flicks, hi: Flicks) => {
    const state = held(lo)
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (held(mid) === state) lo = mid
      else hi = mid
    }
    return hi
  }
  const runs: (readonly [Flicks, Flicks])[] = []
  let start: Flicks | null = held(from) ? null : from
  for (let a = from; a < to; a += HOLD_STEP) {
    const b = Math.min(to, a + HOLD_STEP)
    const wasHeld = start === null, isHeld = held(b)
    if (wasHeld === isHeld) continue
    // The state flips somewhere in (a, b]; it may flip twice inside one cell, which the 10 Hz grid ignores.
    const t = edge(a, b)
    if (wasHeld) start = t
    else { runs.push([start!, t]); start = null }
  }
  if (start !== null) runs.push([start, to])
  return runs.filter(([x, y]) => y > x)
}

/**
 * Audio processing for every audible clip in the range. Unchanged or "match speed" clips are
 * resampled by the render worker; others (and reversed clips) are time-stretched by ffmpeg so
 * pitch matches the preview (where the media element preserves pitch).
 */
export function audioPlan(app: CascadeAPI, range: { start: Flicks; end: Flicks }): Record<string, ClipAudioPlan> {
  const project = app.project()
  const plan: Record<string, ClipAudioPlan> = {}
  for (const { timeline: tl, range: scope } of compositionAudioRanges(project, app.registries, project.activeTimeline, range)) {
    const solo = anySolo(tl.tracks)
    for (const track of tl.tracks) {
      if (!trackAudible(track, solo) || track.kind === 'visual' && track.hidden) continue
      for (const clip of track.clips) {
        if (track.kind !== 'audio' && !app.registries.mediaTypes.get(clip.type)?.hasAudio) continue
        const media = clip.mediaId ? project.media[clip.mediaId] : undefined
        if (!media?.path || media.meta.hasAudio === false) continue
        const active = transitionClipRange(track, clip, tx => !!app.registries.transitions.get(tx.type)?.kinds.includes(track.kind))
        const map = clipTimeMap(clip, tl, app.registries)
        if (map.max === 0) continue
        const available = sourceLocalRange(clip, map, media.meta.duration)
        const from = Math.max(scope.start - clip.start, active.start - clip.start, available.start)
        const to = Math.min(scope.end - clip.start, active.end - clip.start, available.end)
        if (to <= from) continue
        const { semitones, matchSpeed } = pitchOf(clip)
        const o0 = map.offset(from)
        // A reversed clip covers the same source range, read from its end down.
        const a = (clip.sourceIn + o0) / FLICKS, b = (clip.sourceIn + map.offset(to)) / FLICKS
        const sourceStart = Math.max(0, Math.min(a, b))
        const sourceEnd = Math.max(sourceStart, a, b)
        if (sourceEnd <= sourceStart) continue
        const base = { mediaId: media.id, sourceStart, sourceEnd }
        if (!map.reversed && semitones === 0 && (matchSpeed || map.constant === 1)) {
          plan[clip.id] = { mode: 'source', ...base }
          continue
        }
        const shift = Math.pow(2, semitones / 12)
        const at = (t: Flicks) => {
          const tempo = Math.max(MIN_TEMPO, map.speedAt(t))
          return { tempo, pitch: (matchSpeed ? tempo : 1) * shift }
        }
        // One rubberband pass per interval of motion. Rubberband cannot represent zero tempo, so
        // held (zero-speed) intervals are left out and play as silence.
        const runs = map.min > 0 ? [[from, to] as const] : movingRuns(map, from, to)
        const segments = runs.flatMap(([t0, t1]) => {
          const o = map.offset(t0), x = (sourceIn(clip, o)), y = sourceIn(clip, map.offset(t1))
          const sourceStart = Math.max(0, Math.min(x, y)), sourceEnd = Math.max(sourceStart, x, y)
          if (sourceEnd <= sourceStart) return []
          const commands: ClipAudioSegment['commands'] = []
          if (map.constant === null) {
            const n = Math.min(MAX_COMMANDS, Math.max(2, Math.ceil(((t1 - t0) / FLICKS) * 10)))
            for (let i = 1; i < n; i++) {
              const t = t0 + ((t1 - t0) * i) / n
              commands.push({ t: Math.abs(map.offset(t) - o) / FLICKS, ...at(t) })
            }
          }
          return [{ localStart: t0 / FLICKS, localEnd: t1 / FLICKS, sourceStart, sourceEnd, ...at(t0), commands }]
        })
        if (!segments.length) continue
        const [first] = segments, whole = segments.length === 1 && map.min > 0
        plan[clip.id] = { mode: 'stretch', ...base, localStart: first.localStart, tempo: first.tempo, pitch: first.pitch, commands: first.commands,
          ...(map.reversed ? { reverse: true } : {}), ...(whole ? {} : { segments }) }
      }
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
