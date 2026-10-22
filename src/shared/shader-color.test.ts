import { expect, test } from 'vitest'
import { linearToSrgb, shaderColor, srgbToLinear } from './shader-color'

test('shader colors normalize hex/rgb channels and preserve straight alpha', () => {
  expect(shaderColor('#0f08')).toEqual([0, 1, 0, 136/255])
  expect(shaderColor('rgba(255, 128, 0, 0.25)')).toEqual([1, 128/255, 0, 0.25])
  expect(shaderColor('#808080', 'linear')[0]).toBeCloseTo(0.2158605)
  expect(shaderColor('#ffffff80', 'linear')[3]).toBe(128/255)
})

test('sRGB transfer is continuous and round trips dark, mid-grey and bright values', () => {
  expect(srgbToLinear(0)).toBe(0)
  expect(srgbToLinear(1)).toBe(1)
  expect(srgbToLinear(0.04045)).toBeCloseTo(0.0031308, 7)
  for (const v of [0, 0.01, 0.04, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6)
})
