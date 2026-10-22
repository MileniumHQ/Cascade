import type { PropertyContribution, ShaderUniform } from '@core/plugin-api'

/** Reduce spatial work for costly playback chains; never omit an effect or degrade exports. */
export function shaderScale(costs: PropertyContribution['cost'][], mode: 'preview' | 'render', playing: boolean): number {
  if (mode === 'render' || !playing) return 1
  return costs.includes('expensive') ? 0.75 : 1
}

/** Preserve source aspect and cap both dimensions by the displayed box and intrinsic pixels. */
export function shaderSize(source: { width: number; height: number }, box: { width: number; height: number }, dpr: number, scale = 1, max = 8192) {
  const ratio = Math.min(1, Math.max(1, box.width * dpr * scale) / source.width, Math.max(1, box.height * dpr * scale) / source.height, max / source.width, max / source.height)
  return { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)) }
}

export function packUniform(value: ShaderUniform): { kind: 'scalar' | 'vec2' | 'vec3' | 'vec4' | 'array'; data: number[] } {
  const data = Array.isArray(value) ? value : [Number(value)]
  if (!data.length || data.some(v => !Number.isFinite(v))) throw new Error('Shader uniforms must contain finite numbers')
  const kind = !Array.isArray(value) ? 'scalar' : data.length === 2 ? 'vec2' : data.length === 3 ? 'vec3' : data.length === 4 ? 'vec4' : 'array'
  return { kind, data }
}
