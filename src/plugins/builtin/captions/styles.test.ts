import { describe, expect, it } from 'vitest'
import { captionClip } from './clip'
import { builtinCaptionStyles, styleOverBase } from './styles'
import { applyPropertyStyle } from '@core/property-style'
import type { PropertyInstance } from '@shared/project'

const types = (props: PropertyInstance[]) => props.map((p) => p.type)
const make = (type: string, values: Record<string, unknown>): PropertyInstance => ({ id: type, type, enabled: true, params: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])) })

describe('captionClip with styles', () => {
  it('keeps the base look without a style', () => {
    const clip = captionClip('Hi', 0, 10)
    expect(types(clip.properties)).toEqual(['transform', 'size', 'text', 'shadow'])
    expect(clip.properties[2].params.text.value).toBe('Hi')
  })

  it('adds properties a style brings and drops ones it nulls', () => {
    const boxed = builtinCaptionStyles.find((s) => s.id === 'boxed')!.value
    const clip = captionClip('Hi', 0, 10, boxed)
    expect(types(clip.properties)).toEqual(['transform', 'size', 'text', 'fill', 'corners'])
    expect(clip.properties[0].params.position.value).toEqual([0, 0.36])
  })

  it('never lets a style replace the text', () => {
    const clip = captionClip('Hi', 0, 10, { text: { text: 'nope', color: '#f00' } })
    expect(clip.properties[2].params.text.value).toBe('Hi')
    expect(clip.properties[2].params.color.value).toBe('#f00')
  })
})

describe('restyling', () => {
  it('returns a boxed caption to the clean look', () => {
    const boxed = builtinCaptionStyles.find((s) => s.id === 'boxed')!.value
    const clip = captionClip('Hi', 0, 10, boxed)
    applyPropertyStyle(clip.properties, styleOverBase({}), make)
    expect(types(clip.properties)).toEqual(['transform', 'size', 'text', 'shadow'])
    expect(clip.properties[0].params.position.value).toEqual([0, 0.34])
    expect(clip.properties[2].params.text.value).toBe('Hi')
  })

  it('applies a style over the base and keeps untouched params of the style type', () => {
    const merged = styleOverBase({ text: { color: '#ff0' } })
    expect(merged.text).toMatchObject({ color: '#ff0', weight: 750 })
    expect(merged.shadow).toBeTruthy()
    expect(styleOverBase({ shadow: null }).shadow).toBeNull()
  })
})
