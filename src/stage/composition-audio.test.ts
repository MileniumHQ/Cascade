import { expect, test } from 'vitest'
import { constantMap, curveMap, reverseMap } from '@core/time-remap'
import { createRegistries } from '@core/app'
import { FLICKS } from '@shared/time'
import { resampleComposition } from './composition-audio'

const source = [new Float32Array([0, 1, 2, 3, 4]), new Float32Array([4, 3, 2, 1, 0])]
test('composition resampling preserves stereo, trims, fractional positions and speed', () => {
  expect(resampleComposition(source, 2, 0, 2, 2, FLICKS / 2, 0, constantMap(1)).map(c => [...c])).toEqual([[1, 2], [3, 2]])
  expect([...resampleComposition(source, 2, 0, 4, 3, 0, 0, constantMap(1))[0]]).toEqual([0, .5, 1])
  expect([...resampleComposition(source, 2, 0, 2, 3, 0, 0, constantMap(2))[0]]).toEqual([0, 2, 4])
  expect([...resampleComposition(source, 2, FLICKS / 2, 2, 2, FLICKS, 0, constantMap(1))[0]]).toEqual([1, 2])
})
test('reverse, zero holds and ramps use the integrated time map', () => {
  expect([...resampleComposition(source, 2, 0, 2, 3, 2 * FLICKS, 0, reverseMap(constantMap(1)))[0]]).toEqual([4, 3, 2])
  expect([...resampleComposition(source, 2, 0, 2, 3, FLICKS, 0, constantMap(0))[0]]).toEqual([0, 0, 0])
  const map = curveMap(1, [
    { id: 'a', t: 0, value: 0, easing: { id: 'linear' } },
    { id: 'b', t: FLICKS, value: 2, easing: { id: 'linear' } }
  ], createRegistries())
  expect([...resampleComposition(source, 2, 0, 2, 3, 0, 0, map)[0]]).toEqual([0, .5, 2])
})
