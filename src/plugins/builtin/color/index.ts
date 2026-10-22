import { definePlugin, shaderColor, type ParamDef, type PropertyContribution } from '@core/plugin-api'
import { cubeTexture } from './cube'
import * as shaders from './shaders'
import { curvesProperty } from './curves'

const number = (id: string, label: string, value: number, min: number, max: number, step = 0.01): ParamDef => ({ id, label, type: 'number', default: value, min, max, step })
const color = (id: string, label: string, value: string): ParamDef => ({ id, label, type: 'color', default: value })
const rgb = (v: unknown) => shaderColor(String(v)).slice(0, 3)

export const colorProperties: PropertyContribution[] = [
  curvesProperty,
  {
    id: 'chroma-key', name: 'Chroma key', description: 'Remove a key color with edge and spill controls', icon: 'droplet-off', category: 'Keying', cost: 'expensive', stackable: true,
    keywords: ['green screen', 'blue screen', 'matte', 'despill'],
    params: [color('color', 'Key color', '#00b140'), number('tolerance', 'Tolerance', 0.12, 0, 1), number('softness', 'Softness', 0.08, 0, 1), number('spill', 'Spill suppression', 0.5, 0, 1), number('choke', 'Edge shrink (output pixels)', 0, 0, 10, 0.1), { id: 'matte', label: 'Show matte', type: 'toggle', default: false }],
    shader: { fragment: shaders.chroma, uniforms: v => ({ u_key: rgb(v.color), u_tolerance: Number(v.tolerance), u_softness: Number(v.softness), u_spill: Number(v.spill), u_choke: Number(v.choke), u_matte: !!v.matte }) }
  },
  {
    id: 'luma-key', name: 'Luma key', description: 'Remove dark or bright pixels by linear luminance', icon: 'contrast', category: 'Keying', cost: 'cheap', stackable: true,
    params: [number('threshold', 'Threshold', 0.1, 0, 1), number('softness', 'Softness', 0.1, 0, 1), { id: 'invert', label: 'Invert', type: 'toggle', default: false }],
    shader: { fragment: shaders.luma, uniforms: v => ({ u_threshold: Number(v.threshold), u_softness: Number(v.softness), u_invert: !!v.invert }) }
  },
  {
    id: 'lift-gamma-gain', name: 'Lift / Gamma / Gain', description: 'Adjust shadows, midtones and highlights in linear light', icon: 'sliders-horizontal', category: 'Color', cost: 'medium', stackable: true,
    params: [color('lift', 'Lift color', '#808080'), number('liftMaster', 'Lift master', 0, -1, 1), color('gamma', 'Gamma color', '#ffffff'), number('gammaMaster', 'Gamma master', 1, 0.01, 4), color('gain', 'Gain color', '#ffffff'), number('gainMaster', 'Gain master', 1, 0, 4)],
    shader: { fragment: shaders.liftGammaGain, uniforms: v => ({ u_lift: rgb(v.lift).map(c => (c - 128/255)*2 + Number(v.liftMaster)), u_gamma: rgb(v.gamma).map(c => c*Number(v.gammaMaster)), u_gain: rgb(v.gain).map(c => c*Number(v.gainMaster)) }) }
  },
  {
    id: 'exposure-white-balance', name: 'Exposure & white balance', description: 'Exposure, temperature, tint, contrast and saturation', icon: 'sun', category: 'Color', cost: 'medium', stackable: true,
    params: [number('exposure', 'Exposure (stops)', 0, -10, 10, 0.1), number('temperature', 'Temperature', 0, -1, 1), number('tint', 'Tint', 0, -1, 1), number('contrast', 'Contrast', 1, 0, 4), number('saturation', 'Saturation', 1, 0, 4)],
    shader: { fragment: shaders.exposure, uniforms: v => ({ u_exposure: Number(v.exposure), u_temperature: Number(v.temperature), u_tint: Number(v.tint), u_contrast: Number(v.contrast), u_saturation: Number(v.saturation) }) }
  },
  {
    id: 'lut', name: 'LUT', description: 'Apply a .cube 3D lookup table', icon: 'palette', category: 'Color', cost: 'expensive', stackable: true,
    params: [{ id: 'file', label: 'LUT file', type: 'file', default: '', animatable: false, config: { filters: [{ name: '3D LUT', extensions: ['cube'] }] } }, number('intensity', 'Intensity', 1, 0, 1)],
    shader: {
      fragment: shaders.lut,
      uniforms: v => ({ u_intensity: Number(v.intensity) }),
      textures(v, ctx) {
        const path = String(v.file ?? '')
        const key = `cube:${path}`
        return { u_lut: path ? ctx.loadTexture(key, async () => {
          const response = await fetch(ctx.mediaUrl(path))
          if (!response.ok) throw new Error(`Cannot read LUT: ${response.status}`)
          return cubeTexture(await response.text(), key)
        }) : null }
      }
    }
  }
]

export const colorPlugin = definePlugin({
  id: 'cascade.color', name: 'Color and keying',
  activate(ctx) { for (const property of colorProperties) ctx.properties.register(property) }
})
