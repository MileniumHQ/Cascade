/** Auto-ducking math: speech segments from word times, and volume keyframes that dip a bed under them. Pure. */
import type { Flicks } from '@shared/time'

export interface DuckParams {
  /** dB relative to the clip's current volume (negative). */
  amount: number
  attack: Flicks
  release: Flicks
}

/** Merge word spans into speech segments; gaps shorter than `mergeGap` stay inside one segment. Words must be sorted by start. */
export function speechSegments(words: readonly { start: Flicks; end: Flicks }[], mergeGap: Flicks): [Flicks, Flicks][] {
  const segments: [Flicks, Flicks][] = []
  for (const w of words) {
    const last = segments.at(-1)
    if (last && w.start - last[1] < mergeGap) last[1] = Math.max(last[1], w.end)
    else segments.push([w.start, w.end])
  }
  return segments
}

/**
 * Clip-relative volume keyframes (dB) that sit at `base`, fade to `base + amount` over `attack`
 * before each speech segment, hold, and fade back over `release`. Overlapping fades stay down.
 */
export function duckKeyframes(segments: readonly [Flicks, Flicks][], clip: { start: Flicks; duration: Flicks }, base: number, p: DuckParams): { t: Flicks; v: number }[] {
  const low = Math.max(-60, base + p.amount)
  const points: { t: Flicks; v: number }[] = []
  for (const [s0, e0] of segments) {
    const s = s0 - clip.start, e = e0 - clip.start
    if (e + p.release <= 0 || s - p.attack >= clip.duration) continue
    const prev = points.at(-1)
    if (prev && s - p.attack <= prev.t) {
      points.splice(-2, 2, { t: Math.min(clip.duration, e), v: low }, { t: Math.min(clip.duration, e + p.release), v: base })
      continue
    }
    points.push({ t: Math.max(0, s - p.attack), v: s - p.attack < 0 ? low : base }, { t: Math.max(0, s), v: low }, { t: Math.min(clip.duration, e), v: low }, { t: Math.min(clip.duration, e + p.release), v: base })
  }
  return points.filter((p, i) => i === 0 || p.t > points[i - 1].t)
}
