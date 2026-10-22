/** Audio for the agent tools: the timeline mix as export renders it, a source range decoded, and their measurements. */
import type { CascadeAPI } from '@core/app'
import { sourceSpan } from '@core/time-remap'
import type { Clip } from '@shared/project'
import { FLICKS, type Flicks } from '@shared/time'
import { prepareExportRequest } from '../export-request'
import { clock } from './clock'
import { LoudnessMeter, formatDb, sparkline, type LoudnessReading } from './loudness'
import type { SheetAudio } from './sheets'

export const RATE = 48000
/** Longest range a mix render or decode covers (seconds). */
export const MAX_AUDIO_SECONDS = 600

/** Interleaved stereo float32 of [startSec, startSec + durSec) of a file. */
export async function decode(app: CascadeAPI, path: string, startSec: number, durSec: number): Promise<Float32Array | null> {
  const pcm = await app.host!.media.pcm(path, Math.max(0, startSec), durSec, RATE)
  if (!pcm) return null
  return new Float32Array(await (await fetch(pcm.url)).arrayBuffer())
}

let renders = 0
/** Render [start, end) of the timeline through the WAV exporter (the mix as exported) and decode it. */
export async function renderMix(app: CascadeAPI, start: Flicks, end: Flicks, waitExport: (jobId: string) => Promise<void>): Promise<SheetAudio & { path: string }> {
  if (end <= start) throw new Error('The audio range needs end after start')
  if (end - start > MAX_AUDIO_SECONDS * FLICKS) throw new Error(`Audio covers at most ${MAX_AUDIO_SECONDS / 60} minutes at a time; pass start/end`)
  const host = app.host!
  const path = `${(await host.info()).paths.userData}/agent-mix-${++renders % 4}.wav`
  const jobId = await host.export.start(await prepareExportRequest(app, { exporter: 'wav', output: path, range: { start, end } }))
  await waitExport(jobId)
  const data = await decode(app, path, 0, (end - start) / FLICKS)
  if (!data) throw new Error('Could not decode the rendered mix')
  return { data, rate: RATE, start, path }
}

/** A clip's own source audio over the range it plays (not the mix), or null without a file source. */
export async function clipSource(app: CascadeAPI, clip: Clip): Promise<SheetAudio | null> {
  const media = clip.mediaId ? app.project().media[clip.mediaId] : undefined
  if (!media?.path || media.meta.hasAudio === false) return null
  const { lo, hi } = sourceSpan(clip, app.edit.timeMap(clip))
  const dur = Math.min(MAX_AUDIO_SECONDS, (hi - lo) / FLICKS)
  const data = await decode(app, media.path, lo / FLICKS, dur)
  return data && { data, rate: RATE, start: lo }
}

export const show = (r: LoudnessReading, at: (s: number) => string) =>
  `peak ${formatDb(r.peak)} dBFS, RMS ${formatDb(r.rms)} dBFS, ${formatDb(r.integrated)} LUFS integrated (loudest 400 ms ${formatDb(r.momentaryMax)})${r.clipped ? `, CLIPPING: ${r.clipped} samples at ${r.clipTimes.map(at).join(', ')}` : ''}`
export const round1 = (v: number) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null

/** Overall numbers, the loudness strip and silent stretches of a measured range; `t0` = time of sample 0. */
export function summary(meter: LoudnessMeter, t0: Flicks, label: string) {
  const at = (s: number) => clock(t0 + Math.round(s * FLICKS))
  const all = meter.measure(), seconds = meter.duration
  const lines = [`${label}: ${show(all, at)}; ${meter.layout()}`]
  if (all.peak > -1) lines.push('Warning: peaks above -1 dBFS distort on lossy encodes; lower the loudest clips.')
  // The shape over time, so pacing (a beat of silence before a punchline, music swelling over a line) is visible.
  const step = Math.max(0.25, Math.ceil(seconds / 240 * 4) / 4), strip = sparkline(meter.envelope(step)), row = 60
  lines.push(`Loudness over time (1 char = ${step} s; space = silence, ▁ -60 … █ -12 LUFS or louder):`)
  for (let i = 0; i < strip.length; i += row) lines.push(`  ${at(i * step)} |${strip.slice(i, i + row)}|`)
  const quiet = meter.silences()
  lines.push(quiet.length ? `Silent stretches (below -50 LUFS, 0.5 s or longer): ${quiet.slice(0, 40).map(([a, b]) => `${at(a)}–${at(b)} (${(b - a).toFixed(1)}s)`).join(', ')}${quiet.length > 40 ? ` … ${quiet.length - 40} more` : ''}` : 'No silent stretches of 0.5 s or longer.')
  const json = {
    range: { start: clock(t0), end: clock(t0 + Math.round(seconds * FLICKS)) },
    peak: round1(all.peak), rms: round1(all.rms), integrated: round1(all.integrated), momentaryMax: round1(all.momentaryMax),
    clipped: all.clipped, clipTimes: all.clipTimes.map(at), layout: meter.layout(),
    silences: quiet.map(([a, b]) => ({ start: at(a), end: at(b), seconds: +(b - a).toFixed(2) })),
    envelope: { step, lufs: meter.envelope(step).map(round1) }
  }
  return { lines, json, all }
}

/** Envelope PNG (loudness over time, with -14/-23 LUFS guides) as a data URL. */
export function envelopeImage(meter: LoudnessMeter, t0: Flicks): string {
  const W = 1200, H = 240, step = Math.max(0.05, meter.duration / W)
  const env = meter.envelope(step)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#141416'; ctx.fillRect(0, 0, W, H)
  const y = (db: number) => H - 20 - Math.max(0, Math.min(1, (db + 60) / 60)) * (H - 30)
  ctx.font = '12px Inter, sans-serif'
  for (const db of [-14, -23, -40]) { ctx.strokeStyle = '#3a3a40'; ctx.beginPath(); ctx.moveTo(0, y(db)); ctx.lineTo(W, y(db)); ctx.stroke(); ctx.fillStyle = '#8a8a90'; ctx.fillText(`${db} LUFS`, 4, y(db) - 3) }
  ctx.fillStyle = '#82cbff99'
  env.forEach((db, i) => { const x = i * W / env.length; ctx.fillRect(x, y(db), Math.max(1, W / env.length), H - 20 - y(db)) })
  ctx.fillStyle = '#c8c8cc'
  for (let k = 0; k <= 6; k++) { const s = meter.duration * k / 6; ctx.fillText(clock(t0 + Math.round(s * FLICKS)), Math.min(W - 90, k * W / 6 + 2), H - 5) }
  return c.toDataURL('image/png')
}
