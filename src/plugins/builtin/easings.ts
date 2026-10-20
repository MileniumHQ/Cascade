import { definePlugin, type EasingContribution } from '@core/plugin-api'
import { cubicBezier, spring } from '@core/evaluate'

const bez = (id: string, name: string, group: string, pts: [number, number, number, number]): EasingContribution => {
  const f = cubicBezier(...pts)
  return { id, name, group, glyph: 'circle', fn: (p) => f(p) }
}

const bounceOut = (p: number) => {
  const n = 7.5625
  const d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}

/** Keyframe easings. Each applies to the segment starting at its keyframe. */
export const easingsPlugin = definePlugin({
  id: 'cascade.easings',
  name: 'Easings',
  activate(ctx) {
    const list: EasingContribution[] = [
      { id: 'linear', name: 'Linear', group: 'Basic', glyph: 'diamond', fn: (p) => p },
      { id: 'hold', name: 'Hold', group: 'Basic', glyph: 'square', fn: () => 0 },
      bez('ease', 'Ease', 'Basic', [0.25, 0.1, 0.25, 1]),
      bez('ease-in', 'Ease in', 'Basic', [0.42, 0, 1, 1]),
      bez('ease-out', 'Ease out', 'Basic', [0, 0, 0.58, 1]),
      bez('ease-in-out', 'Ease in-out', 'Basic', [0.42, 0, 0.58, 1]),
      bez('quad-in', 'Quad in', 'Power', [0.11, 0, 0.5, 0]),
      bez('quad-out', 'Quad out', 'Power', [0.5, 1, 0.89, 1]),
      bez('quad-in-out', 'Quad in-out', 'Power', [0.45, 0, 0.55, 1]),
      bez('cubic-in', 'Cubic in', 'Power', [0.32, 0, 0.67, 0]),
      bez('cubic-out', 'Cubic out', 'Power', [0.33, 1, 0.68, 1]),
      bez('cubic-in-out', 'Cubic in-out', 'Power', [0.65, 0, 0.35, 1]),
      bez('expo-in', 'Expo in', 'Power', [0.7, 0, 0.84, 0]),
      bez('expo-out', 'Expo out', 'Power', [0.16, 1, 0.3, 1]),
      bez('expo-in-out', 'Expo in-out', 'Power', [0.87, 0, 0.13, 1]),
      bez('back-in', 'Back in', 'Overshoot', [0.36, 0, 0.66, -0.56]),
      bez('back-out', 'Back out', 'Overshoot', [0.34, 1.56, 0.64, 1]),
      bez('back-in-out', 'Back in-out', 'Overshoot', [0.68, -0.6, 0.32, 1.6]),
      {
        id: 'elastic-out',
        name: 'Elastic out',
        group: 'Overshoot',
        glyph: 'triangle',
        params: [{ label: 'Bounciness', default: 3, min: 1, max: 10, step: 0.5 }],
        fn: (p, [k = 3]) => (p === 0 || p === 1 ? p : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / (12 / k))) + 1)
      },
      { id: 'bounce-out', name: 'Bounce out', group: 'Overshoot', glyph: 'triangle', fn: bounceOut },
      {
        id: 'spring',
        name: 'Spring',
        group: 'Physics',
        glyph: 'hourglass',
        params: [
          { label: 'Stiffness', default: 170, min: 1, max: 1000, step: 1 },
          { label: 'Damping', default: 18, min: 0.1, max: 100, step: 0.5 },
          { label: 'Mass', default: 1, min: 0.1, max: 10, step: 0.1 }
        ],
        fn: (p, [s = 170, d = 18, m = 1]) => springCache(s, d, m)(p)
      },
      {
        id: 'cubic-bezier',
        name: 'Custom curve',
        group: 'Custom',
        glyph: 'circle',
        params: [
          { label: 'x1', default: 0.42, min: 0, max: 1, step: 0.01 },
          { label: 'y1', default: 0, min: -1, max: 2, step: 0.01 },
          { label: 'x2', default: 0.58, min: 0, max: 1, step: 0.01 },
          { label: 'y2', default: 1, min: -1, max: 2, step: 0.01 }
        ],
        fn: (p, [a = 0.42, b = 0, c = 0.58, d = 1]) => bezCache(a, b, c, d)(p)
      },
      {
        id: 'steps',
        name: 'Steps',
        group: 'Custom',
        glyph: 'square',
        params: [{ label: 'Steps', default: 4, min: 1, max: 60, step: 1 }],
        fn: (p, [n = 4]) => Math.min(1, Math.floor(p * Math.max(1, Math.round(n))) / Math.max(1, Math.round(n)))
      }
    ]
    for (const e of list) ctx.easings.register(e)
  }
})

const cache = new Map<string, (p: number) => number>()
const springCache = (s: number, d: number, m: number) => {
  const k = `s${s},${d},${m}`
  let f = cache.get(k)
  if (!f) cache.set(k, (f = spring(s, d, m)))
  return f
}
const bezCache = (a: number, b: number, c: number, d: number) => {
  const k = `b${a},${b},${c},${d}`
  let f = cache.get(k)
  if (!f) cache.set(k, (f = cubicBezier(a, b, c, d)))
  return f
}
