import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assembleSegments } from './segments'

const pcm = (...frames: number[]) => Buffer.from(new Float32Array(frames.flatMap((v) => [v, -v])).buffer)
const read = async (path: string) => [...new Float32Array((await readFile(path)).buffer.slice(0))]

it('places segments on one timeline with silence for gaps and trims overlaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'segments-'))
  try {
    await writeFile(join(dir, 'a'), pcm(1, 2))
    await writeFile(join(dir, 'b'), pcm(3, 4))
    await writeFile(join(dir, 'c'), pcm(5, 6))
    const out = join(dir, 'out')
    expect(await assembleSegments(out, [{ path: join(dir, 'a'), startFrame: 0 }, { path: join(dir, 'b'), startFrame: 4 }, { path: join(dir, 'c'), startFrame: 5 }])).toBe(7)
    expect(await read(out)).toEqual([1, -1, 2, -2, 0, 0, 0, 0, 3, -3, 4, -4, 6, -6].map((v) => v))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
