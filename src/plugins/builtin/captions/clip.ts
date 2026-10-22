import type { PropertyStyle } from '@core/property-style'
import { uid, type Clip, type PropertyInstance } from '@shared/project'
import type { Flicks } from '@shared/time'

const property = (type: string, values: Record<string, unknown>): PropertyInstance => ({ id: uid('pi_'), type, enabled: true,
  params: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])) })

/** A caption text clip in the default caption look; `style` overrides parameters by property type. */
export function captionClip(text: string, start: Flicks, end: Flicks, style?: PropertyStyle, data: Record<string, unknown> = {}): Clip {
  const base: [string, Record<string, unknown>][] = [
    ['transform', { position: [0, 0.34], scale: 1, rotation: 0, anchor: [0.5, 0.5] }],
    ['size', { size: [0.88, 0.16], padding: 0 }],
    ['text', { font: 'Inter', size: 0.046, weight: 750, color: '#ffffff', align: 'center', italic: false, tracking: 0, leading: 1.2, stroke: 0.006, strokeColor: '#111111' }],
    // Soft shadow keeps captions legible over bright footage.
    ['shadow', { offset: [0, 0.002], blur: 0.006, color: '#000000cc' }]
  ]
  const properties = base.filter(([type]) => style?.[type] !== null).map(([type, values]) => property(type, { ...values, ...style?.[type], ...(type === 'text' ? { text } : {}) }))
  // Styles can add properties captions don't start with (a box fill, rounded corners…).
  for (const [type, values] of Object.entries(style ?? {})) if (values && !base.some(([t]) => t === type)) properties.push(property(type, values))
  return { id: uid('cl_'), type: 'element', name: text.replace(/\n/g, ' '),
    start, duration: end - start, sourceIn: 0, data: { kind: 'text', ...data }, properties }
}
