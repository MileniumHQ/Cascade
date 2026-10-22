import { describe, expect, it } from 'vitest'
import { ellipsePath } from '@shared/path'
import { maskFragment, maskMode, maskRadii } from './mask'
const values = { shape: ellipsePath(), feather: 0.01, expansion: -0.02, opacity: 0.5, invert: true }

describe('Mask property SVG', () => {
  it('has identical radii and SVG at preview and export resolutions', () => {
    const preview = { width: 400, height: 300, frame: { width: 800, height: 600 } }, render = { width: 1600, height: 1200, frame: { width: 3200, height: 2400 } }
    expect(maskRadii(0.01, preview)).toEqual([0.015, 0.02])
    expect(maskRadii(0.01, render)).toEqual(maskRadii(0.01, preview))
    expect(maskFragment(values, preview, 'f')).toBe(maskFragment(values, render, 'f'))
  })
  it('composes expansion before feather, then inversion and opacity', () => {
    const svg = maskFragment(values, { width: 600, height: 600, frame: { width: 600, height: 600 } }, 'f')
    expect(svg).toContain('operator="erode"'); expect(svg).toContain('tableValues="1 0"'); expect(svg).toContain('opacity="0.5"')
    expect(svg.indexOf('feMorphology')).toBeLessThan(svg.indexOf('feGaussianBlur'))
    expect(maskFragment({ ...values, expansion: 0.02 }, { width: 1, height: 1, frame: { width: 1, height: 1 } }, 'f')).toContain('operator="dilate"')
    expect(maskMode('unknown')).toBe('add'); expect(maskMode('intersect')).toBe('intersect')
  })
})
