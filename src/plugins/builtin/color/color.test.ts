import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { Clip, ShaderContext } from '@core/plugin-api'
import { videoPlugin } from '../media/video'
import { imagePlugin } from '../media/image'
import { elementPlugin } from '../media/element'
import { colorPlugin, colorProperties } from './index'

const context: ShaderContext = { resolution: { width: 1920, height: 1080 }, time: 0, mode: 'preview', mediaUrl: p => p, loadTexture: (_key, load) => load() }

test('built-in correction uniforms have neutral defaults', () => {
  const values = (id: string) => {
    const property = colorProperties.find(p => p.id === id)!
    return property.shader!.uniforms!(Object.fromEntries(property.params.map(p => [p.id, p.default])), context)
  }
  expect(values('lift-gamma-gain')).toEqual({ u_lift: [0, 0, 0], u_gamma: [1, 1, 1], u_gain: [1, 1, 1] })
  expect(values('exposure-white-balance')).toEqual({ u_exposure: 0, u_temperature: 0, u_tint: 0, u_contrast: 1, u_saturation: 1 })
})

test('shader availability uses media capability, including third-party media and predicates', async () => {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([videoPlugin, imagePlugin, elementPlugin, colorPlugin].map(def => ({ def, builtin: true })))
  const property = colorProperties[0]
  const clip = (type: string) => ({ type } as Clip)
  expect(app.edit.propertyApplies(property, clip('video'))).toBe(true)
  expect(app.edit.propertyApplies(property, clip('image'))).toBe(true)
  expect(app.edit.propertyApplies(property, clip('element'))).toBe(false)
  expect(app.edit.propertyApplies({ ...property, appliesTo: () => true }, clip('element'))).toBe(false)
  app.registries.mediaTypes.register({ ...app.registries.mediaTypes.get('image')!, id: 'custom-pixels' }, 'test', false)
  expect(app.edit.propertyApplies(property, clip('custom-pixels'))).toBe(true)
  for (const loaded of host.list(true)) host.deactivate(loaded.def.id)
})
