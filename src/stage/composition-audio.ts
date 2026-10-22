import type { TimeMap } from '@core/time-remap'
import { FLICKS, type Flicks } from '@shared/time'

/** Resample an already mixed composition into the parent's clip-local clock.
 * Stereo effects, nested buses and transitions are baked before the outer time map.
 * Zero-rate regions produce silence rather than a held/DC sample. */
export function resampleComposition(channels: readonly Float32Array[], sourceRate: number, sourceStart: Flicks,
  outputRate: number, frames: number, sourceIn: Flicks, localStart: Flicks, remap: TimeMap, localRate = 1): Float32Array[] {
  const output = channels.map(() => new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    const local = Math.round(localStart + i / outputRate * FLICKS * localRate)
    if (remap.speedAt(local) === 0) continue
    const position = (sourceIn + remap.offset(local) - sourceStart) / FLICKS * sourceRate
    const index = Math.floor(position), fraction = position - index
    if (index < 0) continue
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c]
      output[c][i] = (data[index] ?? 0) * (1 - fraction) + (data[index + 1] ?? 0) * fraction
    }
  }
  return output
}
