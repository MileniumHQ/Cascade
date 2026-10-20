import type { CascadeAPI } from '@core/app'
import type { EasingContribution } from '@core/plugin-api'
import type { EasingRef } from '@shared/project'
import { plotRange, sampleEasing } from './model'

type Regs = CascadeAPI['registries']

export const easingOf = (regs: Regs, ref: EasingRef | undefined): EasingContribution | undefined => regs.easings.get(ref?.id ?? 'linear')

const cache = new Map<string, { d: string; lo: number; hi: number }>()
let cacheRev = -1

/**
 * Unit-box curve path (x 0..100, y 0..100, y up) for mini previews: dope-sheet segments and the
 * preset grid. Cached per easing + params; flushed when easings are re-registered.
 */
export function miniCurve(regs: Regs, ref: EasingRef | undefined, n = 40): { d: string; lo: number; hi: number } {
  if (regs.easings.revision !== cacheRev) {
    cache.clear()
    cacheRev = regs.easings.revision
  }
  const key = `${ref?.id ?? 'linear'}|${ref?.params?.join(',') ?? ''}|${n}`
  let hit = cache.get(key)
  if (!hit) {
    const samples = sampleEasing(easingOf(regs, ref), ref, n)
    const [lo, hi] = plotRange(samples, 0.08)
    let d = ''
    samples.forEach((s, i) => {
      d += `${i ? 'L' : 'M'}${(s.p * 100).toFixed(1)} ${(100 - ((s.y - lo) / (hi - lo)) * 100).toFixed(1)}`
    })
    hit = { d, lo, hi }
    cache.set(key, hit)
  }
  return hit
}
