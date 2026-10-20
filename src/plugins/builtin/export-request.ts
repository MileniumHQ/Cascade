import type { CascadeAPI } from '@core/app'
import type { ExportRequest } from '@shared/ipc'
import { clipEnd } from '@shared/project'
import type { Flicks, FrameRate } from '@shared/time'

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
    workers: app.settings.get<number>('export.workers') ?? 0
  }
}
