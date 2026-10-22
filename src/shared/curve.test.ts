import { describe, expect, it } from 'vitest'
import { bakeCurves, coerceCurvePoints, coerceCurves, compileCurve, curveKey, defaultCurves, interpolateCurves } from './curve'

describe('normalized curves', () => {
  it('coerces finite points, sorts, clamps, deduplicates and supplies endpoints', () => {
    expect(coerceCurvePoints([[0.6, 2], [0.2, -1], [0.2, 0.4], [NaN, 1]])).toEqual([[0, 0], [0.2, 0], [0.6, 1], [1, 1]])
    expect(coerceCurves(null)).toEqual(defaultCurves())
  })
  it('is identity at every sample by default', () => {
    const f = compileCurve([[0, 0], [1, 1]])
    for (let i = 0; i <= 1000; i++) expect(f(i / 1000)).toBeCloseTo(i / 1000, 12)
    const data = bakeCurves(defaultCurves())
    for (let i = 0; i < 256; i++) expect([...data.slice(i * 4, i * 4 + 4)]).toEqual([i, i, i, 255])
  })
  it('passes through control points, preserves extrema and never overshoots intervals', () => {
    for (const points of [[[0, 0], [0.01, 0.7], [0.9, 0.75], [1, 1]], [[0, 0.5], [0.3, 1], [0.4, 0], [1, 0.5]]] as [number, number][][]) {
      const f = compileCurve(points)
      for (const [x, y] of points) expect(f(x)).toBeCloseTo(y)
      for (let i = 0; i < points.length - 1; i++) for (let j = 0; j <= 100; j++) {
        const y = f(points[i][0] + (points[i + 1][0] - points[i][0]) * j / 100)
        expect(y).toBeGreaterThanOrEqual(Math.min(points[i][1], points[i + 1][1]) - 1e-12)
        expect(y).toBeLessThanOrEqual(Math.max(points[i][1], points[i + 1][1]) + 1e-12)
      }
    }
  })
  it('applies master after RGB and keys the full canonical value', () => {
    const v = defaultCurves(); v.r = [[0, 0.5], [1, 0.5]]; v.master = [[0, 1], [1, 0]]
    expect([...bakeCurves(v).slice(0, 4)]).toEqual([128, 255, 255, 255])
    expect(curveKey(v)).toBe(curveKey(structuredClone(v)))
    expect(curveKey(v)).not.toBe(curveKey(defaultCurves()))
    expect(() => bakeCurves(v, 1)).toThrow()
  })
  it('interpolates matching topology, otherwise holds all channels', () => {
    const a = defaultCurves(), b = defaultCurves(); b.master[0][1] = 1
    expect(interpolateCurves(a, b, 0.5).master[0]).toEqual([0, 0.5])
    b.r.splice(1, 0, [0.5, 0.8])
    expect(interpolateCurves(a, b, 0.5)).toEqual(a)
    expect(interpolateCurves(a, b, 1)).toEqual(b)
  })
})
