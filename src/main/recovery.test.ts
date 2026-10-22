import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRecoveryStore } from './recovery'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cascade-rec-')) })
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('recovery store', () => {
  it('writes, lists, reads and discards snapshots', async () => {
    const store = createRecoveryStore(join(dir, 'recovery'))
    expect(await store.list()).toEqual([])
    await store.write({ id: 'p1', name: 'One', savedAt: 10 }, '{"a":1}')
    await store.write({ id: 'p2', name: 'Two', path: '/x.cascade', savedAt: 20 }, '{"b":2}')
    await store.write({ id: 'p1', name: 'One', savedAt: 30 }, '{"a":3}')
    expect((await store.list()).map((m) => [m.id, m.savedAt])).toEqual([['p1', 30], ['p2', 20]])
    expect(await store.read('p1')).toBe('{"a":3}')
    await store.discard('p1')
    expect(await store.read('p1')).toBeNull()
    expect((await store.list()).map((m) => m.id)).toEqual(['p2'])
    expect((await readdir(join(dir, 'recovery'))).sort()).toEqual(['p2.cascade', 'p2.json'])
  })
  it('keeps a discard ordered after a pending write', async () => {
    const store = createRecoveryStore(join(dir, 'ordered'))
    const w = store.write({ id: 'p', name: 'P', savedAt: 1 }, '{}')
    const d = store.discard('p')
    await Promise.all([w, d])
    expect(await store.list()).toEqual([])
  })
})
