/** Decoding and measuring source audio. Used by the editor's audio tools and the agent (MCP) audio tools. */
import type { CascadeAPI } from '@core/app'
import { sourceSpan } from '@core/time-remap'
import type { Clip } from '@shared/project'
import { FLICKS } from '@shared/time'

export const RATE = 48000
/** Longest range a mix render or decode covers (seconds). */
export const MAX_AUDIO_SECONDS = 600

/** What was decoded: interleaved stereo float32, its sample rate and the source time of sample 0 (flicks). */
export interface SourceAudio {
  data: Float32Array
  rate: number
  start: number
}

/** Interleaved stereo float32 of [startSec, startSec + durSec) of a file. */
export async function decode(app: CascadeAPI, path: string, startSec: number, durSec: number): Promise<Float32Array | null> {
  const pcm = await app.host!.media.pcm(path, Math.max(0, startSec), durSec, RATE)
  if (!pcm) return null
  return new Float32Array(await (await fetch(pcm.url)).arrayBuffer())
}

/** A clip's own source audio over the range it plays (not the mix), or null without a file source. */
export async function clipSource(app: CascadeAPI, clip: Clip): Promise<SourceAudio | null> {
  const media = clip.mediaId ? app.project().media[clip.mediaId] : undefined
  if (!media?.path || media.meta.hasAudio === false) return null
  const { lo, hi } = sourceSpan(clip, app.edit.timeMap(clip))
  const dur = Math.min(MAX_AUDIO_SECONDS, (hi - lo) / FLICKS)
  const data = await decode(app, media.path, lo / FLICKS, dur)
  return data && { data, rate: RATE, start: lo }
}
