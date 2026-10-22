import { expect, test } from 'vitest'
import { packUniform, shaderScale, shaderSize } from './gpu-utils'

test('uniform packing distinguishes floats, booleans, vectors and arrays', () => {
  expect(packUniform(true)).toEqual({ kind: 'scalar', data: [1] })
  expect(packUniform(0.5)).toEqual({ kind: 'scalar', data: [0.5] })
  for (const length of [2, 3, 4]) expect(packUniform(Array(length).fill(1)).kind).toBe(`vec${length}`)
  expect(packUniform([1]).kind).toBe('array')
  expect(packUniform([1, 2, 3, 4, 5]).kind).toBe('array')
  expect(() => packUniform([])).toThrow()
  expect(() => packUniform([NaN])).toThrow()
  expect(() => packUniform(Infinity)).toThrow()
})

test('resolution follows adaptive frame size, DPR, aspect, source and GL limits', () => {
  const source = { width: 1920, height: 1080 }
  expect(shaderSize(source, { width: 960, height: 540 }, 1)).toEqual({ width: 960, height: 540 })
  expect(shaderSize(source, { width: 960, height: 540 }, 2)).toEqual(source)
  expect(shaderSize(source, { width: 3840, height: 2160 }, 2)).toEqual(source)
  expect(shaderSize(source, { width: 1920, height: 1080 }, 1, 1, 960)).toEqual({ width: 960, height: 540 })
  expect(shaderSize(source, { width: 960, height: 960 }, 1)).toEqual({ width: 960, height: 540 })
  expect(shaderSize(source, { width: 0, height: 0 }, 1)).toEqual({ width: 1, height: 1 })
})

test('cost reduces expensive playback work while preserving paused and render quality', () => {
  expect(shaderScale(['cheap', 'medium'], 'preview', true)).toBe(1)
  expect(shaderScale(['expensive'], 'preview', true)).toBe(0.75)
  expect(shaderScale(['expensive'], 'preview', false)).toBe(1)
  expect(shaderScale(['expensive'], 'render', true)).toBe(1)
})
