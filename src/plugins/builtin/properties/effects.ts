import { definePlugin, type ParamDef, type PropertyContribution } from '@core/plugin-api'

const n = (v: unknown) => Number(v) || 0
const r = (v: number, d = 4) => +v.toFixed(d)
const visualOnly = (clip: { type: string }) => clip.type !== 'audio'

const simple = (
  id: string,
  name: string,
  description: string,
  icon: string,
  param: Omit<ParamDef, 'id' | 'label' | 'type'> & { label?: string },
  css: (v: number) => string,
  keywords: string[] = [],
  cost: PropertyContribution['cost'] = 'cheap'
): PropertyContribution => ({
  id,
  name,
  description,
  icon,
  category: 'Color & Filters',
  keywords,
  cost,
  appliesTo: visualOnly,
  params: [{ id: 'amount', label: param.label ?? 'Amount', type: param.unit === 'deg' ? 'angle' : 'number', ...param }],
  apply: (v) => ({ filter: [css(n(v.amount))] }),
  summary: (v) => (param.unit === 'percent' ? `${r(n(v.amount) * 100, 1)}%` : String(r(n(v.amount), 2)))
})

/** CSS filter-based effects and a few SVG-filter ones. */
export const effectsPlugin = definePlugin({
  id: 'cascade.properties.effects',
  name: 'Effects',
  activate(ctx) {
    const list: PropertyContribution[] = [
      {
        id: 'blur',
        name: 'Blur',
        description: 'Gaussian blur, resolution-independent',
        icon: 'droplets',
        category: 'Blur',
        keywords: ['gaussian', 'soften', 'defocus'],
        cost: 'medium',
        appliesTo: visualOnly,
        params: [{ id: 'radius', label: 'Radius', type: 'number', unit: 'frameLen', default: 0.01, min: 0, step: 1 }],
        apply: (v, { u }) => (n(v.radius) > 0 ? { filter: [`blur(${u.len(n(v.radius))})`] } : undefined)
      },
      {
        id: 'backdrop-blur',
        name: 'Background blur',
        description: 'Frosted glass: blurs whatever is behind the clip',
        icon: 'glass-water',
        category: 'Blur',
        keywords: ['glass', 'frosted', 'backdrop'],
        cost: 'expensive',
        appliesTo: ['element'],
        params: [
          { id: 'radius', label: 'Radius', type: 'number', unit: 'frameLen', default: 0.02, min: 0, step: 1 },
          { id: 'saturate', label: 'Saturation', type: 'number', unit: 'percent', default: 1.4, min: 0, step: 1 }
        ],
        apply: (v, { u }) => ({ backdropFilter: [`blur(${u.len(n(v.radius))})`, `saturate(${r(n(v.saturate))})`] })
      },
      simple('brightness', 'Brightness', 'Make the clip lighter or darker', 'sun', { unit: 'percent', default: 1.2, min: 0, softMax: 3, step: 1 }, (a) => `brightness(${r(a)})`, ['exposure', 'light']),
      simple('contrast', 'Contrast', 'Increase or decrease contrast', 'contrast', { unit: 'percent', default: 1.2, min: 0, softMax: 3, step: 1 }, (a) => `contrast(${r(a)})`),
      simple('saturation', 'Saturation', 'Color intensity', 'palette', { unit: 'percent', default: 1.3, min: 0, softMax: 3, step: 1 }, (a) => `saturate(${r(a)})`, ['vibrance', 'color']),
      simple('hue', 'Hue shift', 'Rotate all colors around the color wheel', 'rainbow', { unit: 'deg', default: 30, step: 1 }, (a) => `hue-rotate(${r(a, 3)}deg)`, ['color', 'tint']),
      simple('grayscale', 'Black & white', 'Remove color', 'droplet-off', { unit: 'percent', default: 1, min: 0, max: 1, step: 1 }, (a) => `grayscale(${r(a)})`, ['monochrome', 'grayscale', 'desaturate']),
      simple('sepia', 'Sepia', 'Warm vintage tone', 'coffee', { unit: 'percent', default: 1, min: 0, max: 1, step: 1 }, (a) => `sepia(${r(a)})`, ['vintage', 'old']),
      simple('invert', 'Invert', 'Negative image', 'square-split-horizontal', { unit: 'percent', default: 1, min: 0, max: 1, step: 1 }, (a) => `invert(${r(a)})`, ['negative']),
      {
        id: 'color-tint',
        name: 'Tint',
        description: 'Wash the clip with a color',
        icon: 'paintbrush',
        category: 'Color & Filters',
        keywords: ['colorize', 'duotone', 'overlay color'],
        appliesTo: visualOnly,
        params: [
          { id: 'color', label: 'Color', type: 'color', default: '#82cbff' },
          { id: 'amount', label: 'Amount', type: 'number', unit: 'percent', default: 0.5, min: 0, max: 1, step: 1 }
        ],
        apply(v) {
          const c = String(v.color)
          const m = c.match(/^#?([0-9a-f]{6})/i)
          const hex = m ? parseInt(m[1], 16) : 0xffffff
          const [R, G, B] = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
          const a = Math.min(1, Math.max(0, n(v.amount)))
          // Luma-preserving tint: mix original with (luma × color).
          const row = (k: number) => {
            const l = [0.2126 * k * a, 0.7152 * k * a, 0.0722 * k * a]
            return l
          }
          const rr = row(R)
          const gg = row(G)
          const bb = row(B)
          const i = 1 - a
          const mat = [rr[0] + i, rr[1], rr[2], 0, 0, gg[0], gg[1] + i, gg[2], 0, 0, bb[0], bb[1], bb[2] + i, 0, 0, 0, 0, 0, 1, 0].map((x) => r(x, 5)).join(' ')
          return { svgFilter: `<feColorMatrix type="matrix" values="${mat}"/>` }
        }
      },
      {
        id: 'vignette',
        name: 'Vignette',
        description: 'Darken the edges',
        icon: 'circle-dot',
        category: 'Color & Filters',
        keywords: ['edges', 'dark corners'],
        appliesTo: visualOnly,
        params: [
          { id: 'amount', label: 'Amount', type: 'number', unit: 'percent', default: 0.6, min: 0, max: 1, step: 1 },
          { id: 'size', label: 'Size', type: 'number', unit: 'percent', default: 0.6, min: 0, max: 1, step: 1 }
        ],
        apply(v, { elements }) {
          // An overlay layer inside the wrapper; resolution independent via percentages.
          let o = elements.wrapper.querySelector<HTMLElement>(':scope > .cs-vignette')
          if (!o) {
            o = elements.document.createElement('div')
            o.className = 'cs-vignette'
            o.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
            elements.wrapper.appendChild(o)
          }
          const inner = r(n(v.size) * 70, 2)
          o.style.background = `radial-gradient(ellipse at center, transparent ${inner}%, rgba(0,0,0,${r(n(v.amount))}) 100%)`
          return undefined
        }
      }
    ]
    for (const p of list) ctx.properties.register(p)
  }
})
