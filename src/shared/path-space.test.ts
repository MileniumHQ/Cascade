import { describe, expect, it } from 'vitest'
import { quadMapping } from './path-space'

describe('content to preview mapping', () => {
  it('roundtrips rotated, skewed, reflected and perspective boxes', () => {
    for (const quad of [
      [{ x: 10, y: 20 }, { x: 130, y: 80 }, { x: 100, y: 170 }, { x: -20, y: 110 }],
      [{ x: 80, y: 10 }, { x: 10, y: 20 }, { x: 5, y: 100 }, { x: 130, y: 120 }]
    ]) {
      const map = quadMapping(quad)!
      const unit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
      unit.forEach((p, i) => { const q = map.toScreen(p); expect(q.x).toBeCloseTo(quad[i].x); expect(q.y).toBeCloseTo(quad[i].y) })
      for (const p of [{ x: 0.2, y: 0.8 }, { x: -0.1, y: 1.4 }]) {
        const q = map.toLocal(map.toScreen(p)); expect(q.x).toBeCloseTo(p.x, 10); expect(q.y).toBeCloseTo(p.y, 10)
      }
    }
  })
  it('rejects degenerate or missing geometry', () => {
    expect(quadMapping([])).toBeNull()
    expect(quadMapping(Array(4).fill({ x: 0, y: 0 }))).toBeNull()
  })
})
