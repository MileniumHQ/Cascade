import { definePlugin, type PropertyContribution } from '@core/plugin-api'

const n = (v: unknown) => Number(v) || 0
const r = (v: number, d = 4) => +v.toFixed(d)
const vec = (v: unknown): [number, number] => (Array.isArray(v) ? [n(v[0]), n(v[1])] : [0, 0])
const pct = (v: unknown) => `${r(n(v) * 100, 2)}%`
const visualOnly = (clip: { type: string }) => clip.type !== 'audio'

/** Core visual properties: transform, opacity, blending, cropping, sizing, fills and shapes. */
export const visualPropertiesPlugin = definePlugin({
  id: 'cascade.properties.visual',
  name: 'Visual properties',
  activate(ctx) {
    const props: PropertyContribution[] = [
      {
        id: 'transform',
        name: 'Transform',
        description: 'Position, scale, rotation and anchor point',
        icon: 'move',
        category: 'Transform',
        keywords: ['position', 'move', 'scale', 'rotate', 'size', 'zoom'],
        appliesTo: visualOnly,
        params: [
          { id: 'position', label: 'Position', type: 'vec2', unit: 'frameXY', default: [0, 0] },
          { id: 'scale', label: 'Scale', type: 'number', unit: 'percent', default: 1, softMin: 0, softMax: 4, step: 1 },
          { id: 'stretch', label: 'Stretch', type: 'vec2', unit: 'percent', default: [1, 1], step: 1 },
          { id: 'rotation', label: 'Rotation', type: 'angle', unit: 'deg', default: 0, step: 0.5 },
          { id: 'anchor', label: 'Anchor', type: 'vec2', unit: 'percent', default: [0.5, 0.5], step: 1 }
        ],
        apply(v, { u }) {
          const [x, y] = vec(v.position)
          const [ax, ay] = vec(v.anchor)
          const t: string[] = []
          if (x || y) t.push(`translate(${u.x(x)}, ${u.y(y)})`)
          if (n(v.rotation)) t.push(`rotate(${r(n(v.rotation), 3)}deg)`)
          const [sx, sy] = Array.isArray(v.stretch) ? vec(v.stretch) : [1, 1]
          const k = n(v.scale)
          if (sx !== 1 || sy !== 1) t.push(`scale(${r(k * sx)}, ${r(k * sy)})`)
          else if (k !== 1) t.push(`scale(${r(k)})`)
          const style: Record<string, string> = {}
          if (ax !== 0.5 || ay !== 0.5) {
            // Move the box so the anchor sits at the position, then pivot around it.
            t.unshift(`translate(${r((0.5 - ax) * 100, 3)}%, ${r((0.5 - ay) * 100, 3)}%)`)
            style['transform-origin'] = `${pct(ax)} ${pct(ay)}`
          }
          return { transform: t, style }
        },
        summary: (v) => `${r(n(v.scale) * 100, 1)}%${n(v.rotation) ? ` · ${r(n(v.rotation), 1)}°` : ''}`
      },
      {
        id: 'opacity',
        name: 'Opacity',
        description: 'How see-through the clip is',
        icon: 'blend',
        category: 'Compositing',
        keywords: ['alpha', 'transparency', 'fade'],
        appliesTo: visualOnly,
        params: [{ id: 'opacity', label: 'Opacity', type: 'number', unit: 'percent', default: 1, min: 0, max: 1, step: 1 }],
        apply: (v) => (n(v.opacity) === 1 ? undefined : { style: { opacity: String(r(n(v.opacity))) } }),
        summary: (v) => `${r(n(v.opacity) * 100, 1)}%`
      },
      {
        id: 'blend',
        name: 'Blend mode',
        description: 'How the clip mixes with the layers below',
        icon: 'layers',
        category: 'Compositing',
        keywords: ['mix', 'multiply', 'screen', 'overlay', 'composite'],
        appliesTo: visualOnly,
        params: [
          {
            id: 'mode',
            label: 'Mode',
            type: 'select',
            default: 'normal',
            options: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter'].map(
              (m) => ({ value: m, label: m.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) })
            )
          }
        ],
        apply: (v) => ({ style: { 'mix-blend-mode': String(v.mode) } }),
        summary: (v) => String(v.mode)
      },
      {
        id: 'crop',
        name: 'Crop',
        description: 'Trim edges of the clip, with optional softness',
        icon: 'crop',
        category: 'Transform',
        keywords: ['clip', 'mask', 'trim edges', 'inset'],
        appliesTo: visualOnly,
        params: [
          { id: 'top', label: 'Top', type: 'number', unit: 'percent', default: 0, min: 0, max: 1, step: 1 },
          { id: 'right', label: 'Right', type: 'number', unit: 'percent', default: 0, min: 0, max: 1, step: 1 },
          { id: 'bottom', label: 'Bottom', type: 'number', unit: 'percent', default: 0, min: 0, max: 1, step: 1 },
          { id: 'left', label: 'Left', type: 'number', unit: 'percent', default: 0, min: 0, max: 1, step: 1 },
          { id: 'radius', label: 'Roundness', type: 'number', unit: 'frameLen', default: 0, min: 0, step: 1 }
        ],
        apply(v, { u }) {
          const rad = n(v.radius) ? ` round ${u.len(n(v.radius))}` : ''
          return { style: { 'clip-path': `inset(${pct(v.top)} ${pct(v.right)} ${pct(v.bottom)} ${pct(v.left)}${rad})` } }
        }
      },
      {
        id: 'size',
        name: 'Size',
        description: 'Width and height of an element box',
        icon: 'scaling',
        category: 'Shape',
        keywords: ['width', 'height', 'dimensions', 'box'],
        appliesTo: ['element'],
        params: [
          { id: 'size', label: 'Size', type: 'vec2', unit: 'frameXY', default: [0.5, 0.5], step: 1 },
          { id: 'padding', label: 'Padding', type: 'number', unit: 'frameLen', default: 0, min: 0, step: 1 }
        ],
        apply(v, { u }) {
          const [w, h] = vec(v.size)
          return { contentStyle: { width: u.x(w), height: u.y(h), padding: u.len(n(v.padding)) } }
        }
      },
      {
        id: 'fill',
        name: 'Fill',
        description: 'Solid color or gradient background',
        icon: 'paint-bucket',
        category: 'Shape',
        keywords: ['background', 'color', 'gradient', 'solid'],
        appliesTo: ['element'],
        params: [
          { id: 'kind', label: 'Type', type: 'select', default: 'solid', config: { segmented: true }, options: [
            { value: 'solid', label: 'Solid' },
            { value: 'linear', label: 'Linear' },
            { value: 'radial', label: 'Radial' }
          ] },
          { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
          { id: 'color2', label: 'Color 2', type: 'color', default: '#82cbff' },
          { id: 'angle', label: 'Angle', type: 'angle', unit: 'deg', default: 135 }
        ],
        apply(v) {
          const bg =
            v.kind === 'linear'
              ? `linear-gradient(${r(n(v.angle), 2)}deg, ${v.color}, ${v.color2})`
              : v.kind === 'radial'
                ? `radial-gradient(circle, ${v.color}, ${v.color2})`
                : String(v.color)
          return { contentStyle: { background: bg } }
        },
        summary: (v) => String(v.kind === 'solid' ? v.color : v.kind)
      },
      {
        id: 'corners',
        name: 'Corners',
        description: 'Rounded corners',
        icon: 'square-round-corner',
        category: 'Shape',
        keywords: ['radius', 'rounded', 'border radius'],
        appliesTo: visualOnly,
        params: [{ id: 'radius', label: 'Radius', type: 'number', unit: 'frameLen', default: 0.03, min: 0, step: 1 }],
        apply: (v, { u }) => ({ contentStyle: { 'border-radius': u.len(n(v.radius)), overflow: 'hidden' } })
      },
      {
        id: 'border',
        name: 'Border',
        description: 'Outline around the box',
        icon: 'square-dashed',
        category: 'Shape',
        keywords: ['stroke', 'outline'],
        appliesTo: visualOnly,
        params: [
          { id: 'width', label: 'Width', type: 'number', unit: 'frameLen', default: 0.004, min: 0, step: 1 },
          { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
          { id: 'style', label: 'Style', type: 'select', default: 'solid', options: ['solid', 'dashed', 'dotted', 'double'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) }
        ],
        apply: (v, { u }) => ({ contentStyle: { border: `${u.len(n(v.width))} ${v.style} ${v.color}` } })
      },
      {
        id: 'shadow',
        name: 'Shadow',
        description: 'Drop shadow that follows the shape (including text and transparency)',
        icon: 'sun-dim',
        category: 'Effects',
        keywords: ['drop shadow', 'glow'],
        appliesTo: visualOnly,
        stackable: true,
        params: [
          { id: 'offset', label: 'Offset', type: 'vec2', unit: 'frameXY', default: [0, 0.01] },
          { id: 'blur', label: 'Blur', type: 'number', unit: 'frameLen', default: 0.02, min: 0, step: 1 },
          { id: 'color', label: 'Color', type: 'color', default: '#000000aa' }
        ],
        apply(v, { u }) {
          const [x, y] = vec(v.offset)
          return { filter: [`drop-shadow(${u.x(x)} ${u.y(y)} ${u.len(n(v.blur))} ${v.color})`] }
        }
      },
      {
        id: 'skew',
        name: 'Skew',
        description: 'Slant the clip horizontally or vertically',
        icon: 'italic',
        category: 'Transform',
        keywords: ['shear', 'slant'],
        appliesTo: visualOnly,
        params: [
          { id: 'x', label: 'Skew X', type: 'angle', unit: 'deg', default: 0 },
          { id: 'y', label: 'Skew Y', type: 'angle', unit: 'deg', default: 0 }
        ],
        apply: (v) => ({ transform: [`skew(${r(n(v.x), 3)}deg, ${r(n(v.y), 3)}deg)`] })
      },
      {
        id: 'flip',
        name: 'Flip',
        description: 'Mirror horizontally or vertically',
        icon: 'flip-horizontal-2',
        category: 'Transform',
        keywords: ['mirror'],
        appliesTo: visualOnly,
        params: [
          { id: 'h', label: 'Horizontal', type: 'toggle', default: true },
          { id: 'v', label: 'Vertical', type: 'toggle', default: false }
        ],
        apply: (v) => ({ transform: [`scale(${v.h ? -1 : 1}, ${v.v ? -1 : 1})`] })
      },
      {
        id: 'perspective',
        name: '3D rotation',
        description: 'Tilt the clip in 3D space',
        icon: 'rotate-3d',
        category: 'Transform',
        keywords: ['3d', 'tilt', 'perspective', 'rotate x', 'rotate y'],
        appliesTo: visualOnly,
        params: [
          { id: 'rx', label: 'Tilt X', type: 'angle', unit: 'deg', default: 0 },
          { id: 'ry', label: 'Tilt Y', type: 'angle', unit: 'deg', default: 20 },
          { id: 'distance', label: 'Distance', type: 'number', unit: 'frameLen', default: 2, min: 0.1, step: 10 }
        ],
        apply: (v, { u }) => ({ transform: [`perspective(${u.len(n(v.distance))}) rotateX(${r(n(v.rx), 3)}deg) rotateY(${r(n(v.ry), 3)}deg)`] })
      }
    ]
    for (const p of props) ctx.properties.register(p)
  }
})
