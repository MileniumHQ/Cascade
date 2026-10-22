import { describe, expect, it } from 'vitest'
import type { PropertyInstance } from '@shared/project'
import { applyPropertyStyle, generatedKeyframes, withKeyframes } from './property-style'

const prop = (type: string, values: Record<string, unknown>): PropertyInstance => ({ id: `pi_${type}`, type, enabled: true, params: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])) })
const make = (type: string, values: Record<string, unknown>) => (type === 'unknown' ? null : prop(type, values))

describe('applyPropertyStyle', () => {
  it('sets values on the existing instance and keeps other params', () => {
    const props = [prop('text', { color: '#fff', size: 0.05 })]
    expect(applyPropertyStyle(props, { text: { color: '#ff0' } }, make)).toBe(true)
    expect(props[0].params.color.value).toBe('#ff0')
    expect(props[0].params.size.value).toBe(0.05)
  })

  it('drops animation on the params it sets', () => {
    const props = [prop('text', { color: '#fff' })]
    props[0].params.color.keyframes = [{ id: 'k', t: 0, value: '#000', easing: { id: 'linear' } }]
    applyPropertyStyle(props, { text: { color: '#ff0' } }, make)
    expect(props[0].params.color).toEqual({ value: '#ff0' })
  })

  it('adds missing property types and skips unavailable ones', () => {
    const props = [prop('text', {})]
    expect(applyPropertyStyle(props, { fill: { color: '#000' }, unknown: { a: 1 } }, make)).toBe(true)
    expect(props.map((p) => p.type)).toEqual(['text', 'fill'])
  })

  it('removes a type with null', () => {
    const props = [prop('text', {}), prop('fill', {}), prop('corners', {})]
    expect(applyPropertyStyle(props, { fill: null, corners: null, shadow: null }, make)).toBe(true)
    expect(props.map((p) => p.type)).toEqual(['text'])
  })

  it('reports no change for an empty style', () => {
    expect(applyPropertyStyle([prop('text', {})], {}, make)).toBe(false)
  })
})

describe('generatedKeyframes', () => {
  it('resolves start- and end-relative times, sorted and clamped', () => {
    const frames = generatedKeyframes({ opacity: [{ t: 100, value: 1, fromEnd: true }, { t: 0, value: 0, easing: 'ease-out' }, { t: 5000, value: 1 }] }, 1000, 'linear')
    expect(frames.opacity.map((k) => [k.t, k.value, k.easing.id])).toEqual([[0, 0, 'ease-out'], [900, 1, 'linear'], [1000, 1, 'linear']])
  })

  it('attaches frames to an instance and uses the first value as the static one', () => {
    const inst = withKeyframes(prop('opacity', { opacity: 1 }), generatedKeyframes({ opacity: [{ t: 0, value: 0 }, { t: 10, value: 1 }] }, 100, 'linear'))
    expect(inst.params.opacity.value).toBe(0)
    expect(inst.params.opacity.keyframes).toHaveLength(2)
  })
})
