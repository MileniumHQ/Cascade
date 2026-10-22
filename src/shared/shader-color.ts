import { parseColor } from './color'

export const srgbToLinear = (v: number): number => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
export const linearToSrgb = (v: number): number => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055

/** Hex / rgb[a] CSS color → straight normalized RGBA, optionally linear-light RGB. */
export function shaderColor(color: string, space: 'srgb' | 'linear' = 'srgb'): number[] {
  const [r, g, b, a] = parseColor(color)
  const rgb = [r, g, b].map(v => Math.max(0, Math.min(1, v / 255)))
  return [...(space === 'linear' ? rgb.map(srgbToLinear) : rgb), Math.max(0, Math.min(1, a))]
}
