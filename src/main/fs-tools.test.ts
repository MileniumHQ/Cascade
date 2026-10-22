import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsMany, findByName } from './fs-tools'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cascade-fs-'))
  await mkdir(join(root, 'a', 'b'), { recursive: true })
  await mkdir(join(root, '.hidden'), { recursive: true })
  await writeFile(join(root, 'top.mp4'), '')
  await writeFile(join(root, 'a', 'b', 'Deep.MOV'), '')
  await writeFile(join(root, 'a', 'dup.wav'), '')
  await writeFile(join(root, 'a', 'b', 'dup.wav'), '')
  await writeFile(join(root, '.hidden', 'secret.mp4'), '')
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('fs tools', () => {
  it('checks many paths at once', async () => {
    expect(await existsMany([join(root, 'top.mp4'), join(root, 'nope.mp4')])).toEqual([true, false])
  })
  it('finds files by name, closest first, skipping hidden folders', async () => {
    const hits = await findByName(root, ['top.mp4', 'deep.mov', 'dup.wav', 'secret.mp4', 'missing.mp4'])
    expect(hits['top.mp4']).toBe(join(root, 'top.mp4'))
    expect(hits['deep.mov']).toBe(join(root, 'a', 'b', 'Deep.MOV'))
    expect(hits['dup.wav']).toBe(join(root, 'a', 'dup.wav'))
    expect(hits['secret.mp4']).toBeUndefined()
    expect(hits['missing.mp4']).toBeUndefined()
  })
})
