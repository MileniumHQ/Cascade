import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { generatedKeyframes } from '@core/property-style'
import { FLICKS } from '@shared/time'
import { templates, titleGenerators, titleLayout } from './templates'

const project = (width: number, height: number) => {
  const p = createProject('t')
  return { ...p, settings: { ...p.settings, width, height } }
}

describe('titleLayout', () => {
  it('keeps 16:9 designs as they are', () => {
    const l = titleLayout(project(1920, 1080))
    expect(l.w(0.36)).toBe(0.36)
    expect(l.text(0.05)).toBe(0.05)
  })

  it('widens boxes and shrinks text in tall frames, within the frame', () => {
    const l = titleLayout(project(1080, 1920))
    expect(l.w(0.36)).toBeGreaterThan(0.36)
    expect(l.w(0.9)).toBeLessThanOrEqual(0.92)
    expect(l.text(0.1)).toBe(0.05)
  })
})

describe('title generators', () => {
  it('are element generators in the Titles category with unique ids', () => {
    const gens = titleGenerators()
    expect(gens).toHaveLength(templates.length)
    expect(new Set(gens.map((g) => g.id)).size).toBe(gens.length)
    for (const g of gens) {
      expect(g.mediaType).toBe('element')
      expect(g.category).toBe('Titles')
    }
  })

  it('build text clips whose animation stays within a 5 s clip', () => {
    for (const g of titleGenerators()) {
      const { properties } = g.create(project(1920, 1080))
      expect(properties?.some((p) => p.type === 'text')).toBe(true)
      for (const prop of properties ?? []) {
        for (const frames of Object.values(generatedKeyframes(prop.keyframes ?? {}, 5 * FLICKS, 'linear'))) {
          expect(frames.length).toBeGreaterThanOrEqual(2)
          expect(frames[0].t).toBeGreaterThanOrEqual(0)
          expect(frames.at(-1)!.t).toBeLessThanOrEqual(5 * FLICKS)
        }
      }
    }
  })

  it('place the lower third inside the frame', () => {
    const { properties } = titleGenerators()[0].create(project(1920, 1080))
    const [x, y] = properties!.find((p) => p.type === 'transform')!.values!.position as number[]
    expect(Math.abs(x)).toBeLessThan(0.5)
    expect(Math.abs(y)).toBeLessThan(0.5)
  })
})
