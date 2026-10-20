import { definePlugin } from '@core/plugin-api'

const n = (v: unknown) => Number(v) || 0
const r = (v: number, d = 4) => +v.toFixed(d)
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'])
/** CSS family token: generic families must stay unquoted, names are quoted. */
const family = (f: string) => (GENERIC.has(f) ? f : `'${f.replace(/'/g, '')}'`)

/** Text content and typography for element clips. */
export const textPropertiesPlugin = definePlugin({
  id: 'cascade.properties.text',
  name: 'Text',
  activate(ctx) {
    ctx.properties.register({
      id: 'text',
      name: 'Text',
      description: 'Text content, font, size, color and alignment',
      icon: 'type',
      category: 'Text',
      keywords: ['title', 'caption', 'font', 'typography', 'words'],
      appliesTo: ['element'],
      params: [
        { id: 'text', label: 'Text', type: 'text', default: 'Your text', config: { multiline: true } },
        { id: 'font', label: 'Font', type: 'font', default: 'Inter' },
        { id: 'size', label: 'Size', type: 'number', unit: 'frameLen', default: 0.08, min: 0, step: 1 },
        { id: 'weight', label: 'Weight', type: 'number', default: 700, min: 100, max: 1000, step: 10 },
        { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
        {
          id: 'align',
          label: 'Align',
          type: 'select',
          default: 'center',
          config: { segmented: true },
          options: [
            { value: 'left', label: 'Left', icon: 'align-left' },
            { value: 'center', label: 'Center', icon: 'align-center' },
            { value: 'right', label: 'Right', icon: 'align-right' }
          ]
        },
        { id: 'italic', label: 'Italic', type: 'toggle', default: false },
        { id: 'tracking', label: 'Letter spacing', type: 'number', unit: 'percent', default: 0, softMin: -0.2, softMax: 0.5, step: 0.5 },
        { id: 'leading', label: 'Line height', type: 'number', default: 1.15, min: 0.5, max: 4, step: 0.05 },
        { id: 'stroke', label: 'Outline', type: 'number', unit: 'frameLen', default: 0, min: 0, step: 0.5 },
        { id: 'strokeColor', label: 'Outline color', type: 'color', default: '#000000' }
      ],
      apply(v, { u }) {
        const style: Record<string, string> = {
          'font-family': `${family(String(v.font))}, system-ui, sans-serif`,
          'font-size': u.len(n(v.size)),
          'font-weight': String(Math.round(n(v.weight))),
          color: String(v.color),
          'text-align': String(v.align),
          'justify-content': v.align === 'left' ? 'flex-start' : v.align === 'right' ? 'flex-end' : 'center',
          'font-style': v.italic ? 'italic' : 'normal',
          'letter-spacing': `${r(n(v.tracking))}em`,
          'line-height': String(r(n(v.leading), 3))
        }
        if (n(v.stroke) > 0) {
          style['-webkit-text-stroke'] = `${u.len(n(v.stroke))} ${v.strokeColor}`
          style['paint-order'] = 'stroke fill'
        }
        return { contentStyle: style, extra: { text: String(v.text ?? '') } }
      },
      summary: (v) => String(v.text ?? '').split('\n')[0].slice(0, 28)
    })
  }
})
