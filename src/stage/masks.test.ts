import { describe, expect, it, vi } from 'vitest'
import { composeMaskSvg, compositeMaskAlpha, namespaceMaskSvg } from './masks'
const box = { width: 640, height: 360, frame: { width: 1280, height: 720 } }

describe('generic mask composition', () => {
  it('implements Porter–Duff modes with fractional alpha', () => {
    expect(compositeMaskAlpha(0.4, 0.5, 'add')).toBeCloseTo(0.7)
    expect(compositeMaskAlpha(0.4, 0.5, 'subtract')).toBeCloseTo(0.2)
    expect(compositeMaskAlpha(0.4, 0.5, 'intersect')).toBeCloseTo(0.2)
    expect(compositeMaskAlpha(0.4, 0.5, 'difference')).toBeCloseTo(0.5)
    for (const mode of ['add', 'subtract', 'intersect', 'difference'] as const) for (const a of [0, 0.2, 0.7, 1]) for (const b of [0, 0.2, 0.7, 1]) {
      const value = compositeMaskAlpha(a, b, mode); expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1)
    }
  })
  it('scopes IDs and references independently for every plugin fragment', () => {
    expect(namespaceMaskSvg('<filter id="blur"/><g filter="url(#blur)"><use href="#blur"/></g>', 'a-')).toBe('<filter id="a-blur"/><g filter="url(#a-blur)"><use href="#a-blur"/></g>')
    expect(namespaceMaskSvg('<path data-id="keep" id="p"/>', 'a-')).toBe('<path data-id="keep" id="a-p"/>')
    const svg = composeMaskSvg([0, 1].map(() => ({ svg: '<filter id="f"/><path filter="url(#f)"/>', mode: 'add' })), box)
    expect(svg).toContain('id="layer0-f"'); expect(svg).toContain('id="layer1-f"')
    expect(svg).not.toContain('id="f"')
  })
  it('starts subtraction from opaque, handles XOR by additive exclusive terms and preserves order', () => {
    expect(composeMaskSvg([], box)).toBe('')
    const svg = composeMaskSvg([{ svg: '<path/>', mode: 'subtract' }, { svg: '<ellipse/>', mode: 'difference' }, { svg: '<rect/>', mode: 'intersect' }], box)
    expect(svg).toContain('mask="url(#m0inv)"')
    expect(svg).toContain('mix-blend-mode:plus-lighter')
    expect(svg).toContain('<use href="#r1" mask="url(#m2)"/>')
  })
  it('skips a failed plugin callback without losing other layers', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svg = composeMaskSvg([{ svg() { throw new Error('plugin failure') }, mode: 'add' }, { svg: '<rect/>', mode: 'add' }], box)
      expect(svg).toContain('<g id="s0"><rect/></g>')
      expect(svg).not.toContain('id="s1"')
      expect(warning).toHaveBeenCalledOnce()
    } finally { warning.mockRestore() }
  })
  it('evaluates SVG callbacks against the current layout', () => {
    const svg = composeMaskSvg([{ svg: b => `<rect data-width="${b.width}"/>`, mode: 'add' }], box)
    expect(svg).toContain('data-width="640"')
  })
})
