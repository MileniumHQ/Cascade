import { describe, expect, it } from 'vitest'
import { coercePath, cubicPoint, ellipsePath, hitPathPoint, hitPathSegment, insertPathPoint, interpolatePath, pathBounds, pathFromSvg, pathSegment, pathToSvg, rectanglePath, togglePathSmooth } from './path'

describe('Bézier paths', () => {
  it('constructs rectangles and ellipses with exact bounds', () => {
    expect(pathBounds(rectanglePath())).toEqual({ x: 0.2, y: 0.2, width: 0.6000000000000001, height: 0.6000000000000001 })
    const bounds = pathBounds(ellipsePath())!
    expect(bounds.x).toBeCloseTo(0.2); expect(bounds.y).toBeCloseTo(0.2); expect(bounds.width).toBeCloseTo(0.6); expect(bounds.height).toBeCloseTo(0.6)
  })
  it('roundtrips generated open/closed SVG cubics and accepts relative lines', () => {
    for (const p of [rectanglePath(), ellipsePath(), { ...ellipsePath(), closed: false }]) {
      const q = pathFromSvg(pathToSvg(p))
      expect(q.closed).toBe(p.closed); expect(q.points.length).toBe(p.points.length)
      for (let i = 0; i < p.points.length - 1; i++) for (const t of [0, 0.3, 0.8, 1]) {
        const a = cubicPoint(pathSegment(p, i), t), b = cubicPoint(pathSegment(q, i), t)
        expect(a.x).toBeCloseTo(b.x, 8); expect(a.y).toBeCloseTo(b.y, 8)
      }
    }
    expect(pathFromSvg('m .1 .2 l .3 0 v .4 h -.3 z').points).toHaveLength(4)
    expect(() => pathFromSvg('M0 0 Q1 1 2 2')).toThrow('Unsupported')
    expect(() => pathFromSvg('M0 0 C 1')).toThrow()
    expect(() => pathFromSvg('M0 0 M1 1')).toThrow('subpaths')
  })
  it('splits any cubic exactly, including its closing segment, without mutation', () => {
    const p = ellipsePath(), before = structuredClone(p)
    for (const index of [0, 3]) {
      const split = insertPathPoint(p, index, 0.37)
      for (const t of [0, 0.15, 0.5, 0.9, 1]) {
        const a = cubicPoint(pathSegment(p, index), t)
        const b = t <= 0.37 ? cubicPoint(pathSegment(split, index), t / 0.37) : cubicPoint(pathSegment(split, index + 1), (t - 0.37) / 0.63)
        expect(a.x).toBeCloseTo(b.x, 12); expect(a.y).toBeCloseTo(b.y, 12)
      }
    }
    expect(p).toEqual(before)
  })
  it('uses curve extrema, not handles, for bounding boxes', () => {
    const p = { closed: false, points: [{ x: 0, y: 0, out: [0, 1] as [number, number] }, { x: 1, y: 0, in: [0, 1] as [number, number] }] }
    expect(pathBounds(p)).toEqual({ x: 0, y: 0, width: 1, height: 0.75 })
    expect(pathBounds({ closed: false, points: [] })).toBeNull()
  })
  it('hits points and transformed segments with screen-space tolerance', () => {
    const p = rectanglePath()
    expect(hitPathPoint(p, { x: 0.21, y: 0.2 }, 0.02)).toBe(0)
    expect(hitPathPoint(p, { x: 1, y: 1 }, 0.02)).toBeNull()
    expect(hitPathSegment(p, p.points[0], 0)?.t).toBe(0)
    const hit = hitPathSegment(p, { x: 500, y: 21 }, 2, q => ({ x: q.x * 1000, y: q.y * 100 }))!
    expect(hit.index).toBe(0); expect(hit.t).toBeCloseTo(0.5, 3)
    expect(hitPathSegment(p, { x: 500, y: 50 }, 2, q => ({ x: q.x * 1000, y: q.y * 100 }))).toBeNull()
  })
  it('interpolates handles from zero and holds incompatible topology', () => {
    const a = rectanglePath(), b = ellipsePath(), q = interpolatePath(a, b, 0.5)
    expect(q.points[0].x).toBeCloseTo(0.35); expect(q.points[0].out?.[0]).toBeCloseTo(b.points[0].out![0] / 2)
    const different = insertPathPoint(b, 0, 0.5)
    expect(interpolatePath(a, different, 0.9)).toEqual(a)
    expect(interpolatePath(a, different, 1)).toEqual(different)
    expect(coercePath({ points: [{ x: Infinity, y: 1 }] }, a)).toEqual(a)
    expect(togglePathSmooth(togglePathSmooth(a, 0), 0)).toEqual(a)
  })
})
