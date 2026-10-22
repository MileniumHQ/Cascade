import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = join(__dirname, '..')
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [])
const importsOf = (dir: string, other: string) => files(join(root, dir)).filter((f) => new RegExp(`from '(\\.\\./)+${other}(/|')`).test(readFileSync(f, 'utf8')))

it('audio-tools and the MCP plugin share code through core/shared modules, not each other', () => {
  expect(importsOf('audio-tools', 'mcp')).toEqual([])
  expect(importsOf('mcp', 'audio-tools')).toEqual([])
})
