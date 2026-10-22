import type { GeneratedProperty, GeneratorContribution, Project } from '@core/plugin-api'
import { FLICKS } from '@shared/time'

/** Layout numbers that adapt template sizes (designed for 16:9) to the project's aspect ratio. */
export interface TitleLayout {
  /** Frame width ÷ height. */
  aspect: number
  /** A width designed for 16:9, as a fraction of the frame width in this project (capped to the frame). */
  w(fraction: number): number
  /** Text size designed for 16:9, as a fraction of the frame height (smaller in tall frames). */
  text(size: number): number
}

export function titleLayout(project: Project): TitleLayout {
  const aspect = project.settings.width / Math.max(1, project.settings.height)
  const widen = Math.max(1, 16 / 9 / aspect)
  const shrink = Math.min(1, Math.max(0.5, aspect / (16 / 9)))
  const round = (v: number) => Math.round(v * 10000) / 10000
  return { aspect, w: (f) => round(Math.min(0.92, f * widen)), text: (s) => round(s * shrink) }
}

const sec = (s: number) => Math.round(s * FLICKS)

/** Opacity fading in at the start and out at the end of the clip. */
const opacity = (inSec: number, outSec = inSec): GeneratedProperty => ({
  type: 'opacity',
  keyframes: {
    opacity: [
      { t: 0, value: 0, easing: 'ease-out' },
      { t: sec(inSec), value: 1 },
      { t: sec(outSec), value: 1, fromEnd: true, easing: 'ease-in' },
      { t: 0, value: 0, fromEnd: true }
    ]
  }
})

interface Template {
  id: string
  name: string
  description: string
  icon: string
  build(project: Project, l: TitleLayout): { name: string; properties: GeneratedProperty[] }
}

const SHADOW = { offset: [0, 0.004], blur: 0.014, color: '#000000b3' }

export const templates: Template[] = [
  {
    id: 'title.lowerThird',
    name: 'Lower third',
    description: 'Name and subtitle in a box, sliding in from the left',
    icon: 'subtitles',
    build(_p, l) {
      const w = l.w(0.36), h = 0.15
      const x = -0.5 + 0.05 + w / 2, y = 0.5 - 0.1 - h / 2
      return {
        name: 'Lower third',
        properties: [
          {
            type: 'transform',
            values: { position: [x, y] },
            keyframes: { position: [{ t: 0, value: [x - 0.04, y], easing: 'ease-out' }, { t: sec(0.6), value: [x, y] }] }
          },
          opacity(0.5, 0.4),
          { type: 'size', values: { size: [w, h], padding: 0.022 } },
          { type: 'fill', values: { color: '#0e0e11e6' } },
          { type: 'corners', values: { radius: 0.012 } },
          { type: 'text', values: { text: 'Name\nTitle or subtitle', size: l.text(0.05), weight: 750, align: 'left', leading: 1.25, restSize: 0.62, restWeight: 450, restOpacity: 0.72 } }
        ]
      }
    }
  },
  {
    id: 'title.center',
    name: 'Title',
    description: 'Large centered title with a smaller line below',
    icon: 'title',
    build(_p, l) {
      return {
        name: 'Title',
        properties: [
          {
            type: 'transform',
            keyframes: { scale: [{ t: 0, value: 0.94, easing: 'ease-out' }, { t: sec(0.8), value: 1 }] }
          },
          opacity(0.6, 0.5),
          { type: 'size', values: { size: [l.w(0.8), 0.3] } },
          { type: 'text', values: { text: 'Title\nSubtitle', size: l.text(0.12), weight: 800, leading: 1.2, restSize: 0.4, restWeight: 450, restOpacity: 0.85 } },
          { type: 'shadow', values: SHADOW }
        ]
      }
    }
  },
  {
    id: 'title.subtitleBar',
    name: 'Subtitle bar',
    description: 'Full-width translucent bar with one line of text',
    icon: 'captions',
    build(_p, l) {
      const h = 0.11
      return {
        name: 'Subtitle bar',
        properties: [
          { type: 'transform', values: { position: [0, 0.5 - h / 2] } },
          opacity(0.3),
          { type: 'size', values: { size: [1, h] } },
          { type: 'fill', values: { color: '#000000b8' } },
          { type: 'text', values: { text: 'Subtitle text', size: l.text(0.04), weight: 600 } }
        ]
      }
    }
  },
  {
    id: 'title.captionBox',
    name: 'Caption box',
    description: 'Dark text on a rounded white box that pops in',
    icon: 'quote',
    build(_p, l) {
      const y = 0.5 - 0.17
      return {
        name: 'Caption box',
        properties: [
          {
            type: 'transform',
            values: { position: [0, y] },
            keyframes: { scale: [{ t: 0, value: 0.88, easing: 'expo-out' }, { t: sec(0.4), value: 1 }] }
          },
          opacity(0.25, 0.25),
          { type: 'size', values: { size: [l.w(0.5), 0.1], padding: 0.016 } },
          { type: 'fill', values: { color: '#ffffff' } },
          { type: 'corners', values: { radius: 0.014 } },
          { type: 'text', values: { text: 'Caption text', size: l.text(0.045), weight: 700, color: '#111113' } },
          { type: 'shadow', values: { offset: [0, 0.004], blur: 0.016, color: '#00000066' } }
        ]
      }
    }
  },
  {
    id: 'title.endCard',
    name: 'End card',
    description: 'Full-frame card with a closing line and a call to action',
    icon: 'call-to-action',
    build(_p, l) {
      return {
        name: 'End card',
        properties: [
          opacity(0.6, 0.6),
          { type: 'size', values: { size: [1, 1] } },
          { type: 'fill', values: { color: '#0b0b0d' } },
          { type: 'text', values: { text: 'Thanks for watching\nSubscribe for more', size: l.text(0.09), weight: 800, leading: 1.25, restSize: 0.45, restWeight: 450, restOpacity: 0.7 } }
        ]
      }
    }
  }
]

/** The templates as generators (element clips built from ordinary properties). */
export function titleGenerators(): GeneratorContribution[] {
  return templates.map((t, i) => ({
    id: t.id,
    priority: 500 + i,
    name: t.name,
    description: t.description,
    icon: t.icon,
    mediaType: 'element',
    category: 'Titles',
    create: (project: Project) => {
      const built = t.build(project, titleLayout(project))
      return { name: built.name, clipData: { kind: 'title', template: t.id }, properties: built.properties }
    }
  }))
}
