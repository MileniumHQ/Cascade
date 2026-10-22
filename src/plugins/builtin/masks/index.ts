import { definePlugin, type PropertyContribution } from '@core/plugin-api'
import { ellipsePath } from '@shared/path'
import { maskFragment, maskMode } from './mask'

export const maskProperty: PropertyContribution = {
  id: 'mask', name: 'Mask', description: 'Feathered Bézier mask in the clip’s content space', icon: 'square-dashed', category: 'Compositing', stackable: true,
  keywords: ['ellipse', 'rectangle', 'bezier', 'path', 'matte'],
  params: [
    { id: 'shape', label: 'Shape', type: 'path', default: ellipsePath(), config: { presets: true } },
    { id: 'mode', label: 'Mode', type: 'select', default: 'add', animatable: true, options: ['add', 'subtract', 'intersect', 'difference'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
    { id: 'feather', label: 'Feather', type: 'number', unit: 'frameLen', default: 0, min: 0, softMax: 0.2, step: 1 },
    { id: 'expansion', label: 'Expansion', type: 'number', unit: 'frameLen', default: 0, softMin: -0.1, softMax: 0.1, step: 1 },
    { id: 'opacity', label: 'Opacity', type: 'number', unit: 'percent', default: 1, min: 0, max: 1, step: 1 },
    { id: 'invert', label: 'Invert', type: 'toggle', default: false, animatable: true }
  ],
  apply(v) {
    // Each callback has its own scoped SVG fragment; compositor namespaces IDs per layer.
    return { mask: [{ svg: box => maskFragment(v, box, 'shape-filter'), mode: maskMode(v.mode) }] }
  }
}
export const masksPlugin = definePlugin({
  id: 'cascade.masks', name: 'Masks',
  activate(ctx) { ctx.properties.register(maskProperty) }
})
