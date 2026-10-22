import { expect, test } from 'vitest'
import { cubeTexture, parseCube } from './cube'

const rows = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1']
const identity = `LUT_3D_SIZE 2\n${rows.join('\n')}`

test('parse .cube comments, title, BOM/CRLF, domain and red-fastest entries', () => {
  const lut = parseCube(`\uFEFF# comment\r\nTITLE "Identity"\r\nDOMAIN_MIN -1 -2 -3\r\nDOMAIN_MAX 1 2 3\r\n${identity} # last pixel\n`)
  expect(lut.size).toBe(2)
  expect(lut.domainMin).toEqual([-1, -2, -3])
  expect(lut.domainMax).toEqual([1, 2, 3])
  expect([...lut.data.slice(3, 6)]).toEqual([1, 0, 0])
  expect([...lut.data.slice(12, 15)]).toEqual([0, 0, 1])
  expect(parseCube(identity).domainMax).toEqual([1, 1, 1])
})

test('packed texture preserves lattice and places domain outside the lattice', () => {
  const texture = cubeTexture(identity, 'identity')
  expect([texture.width, texture.height, texture.depth]).toEqual([4, 2, 2])
  expect(texture.key).toBe('identity')
  expect([...texture.data.slice(0, 6)]).toEqual([0, 0, 0, 1, 1, 1])
  expect([...texture.data.slice(6, 12)]).toEqual([0, 0, 0, 1, 0, 0])
  expect([...texture.data.slice(-6)]).toEqual([0, 1, 1, 1, 1, 1])
})

test.each([
  '', 'LUT_1D_SIZE 2\n0 0 0', 'LUT_3D_SIZE 1', 'LUT_3D_SIZE 2.5', 'LUT_3D_SIZE 66',
  `${identity}\n0 0 0`, identity.replace('1 1 1', 'NaN 1 1'), identity.replace('1 1 1', '1 1'),
  `DOMAIN_MIN 1 0 0\n${identity}`, `DOMAIN_MAX 1 1\n${identity}`, `DOMAIN_MIN 0 0 Infinity\n${identity}`,
  `LUT_3D_SIZE 2\n${identity}`, identity.replace('1 1 1', '')
])('reject malformed, unsupported or incomplete .cube: %s', text => {
  expect(() => parseCube(text)).toThrow()
})
