import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FLICKS } from '../../shared/time'
vi.mock('../media', () => ({ createMediaService: () => ({ probe: async () => ({ duration: 10 * FLICKS, hasVideo: false, hasAudio: false }) }) }))
vi.mock('../ffmpeg', () => ({ getFFmpegTools: async () => ({ ffmpeg: 'mock' }), spawnTracked: () => { throw new Error('Unexpected process') } }))
import { createAnalysisService } from './index'
const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { force: true, recursive: true }) })
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cascade-analysis-test-')); paths.push(dir)
  const source = join(dir, 'source'); await writeFile(source, 'test')
  return { dir, source }
}
it('records model/stream failures independently, lists cached partials, and invalidates a changed source', async () => {
  const { dir, source } = await setup(), service = createAnalysisService(dir)
  const result = await service.run(source, { parts: ['events', 'shots'] })
  expect(result.parts).toEqual([])
  expect(result.errors?.events).toContain('model missing')
  expect(result.errors?.shots).toContain('no video')
  expect(await service.cached(source)).toEqual([result])
  await writeFile(source, 'changed source')
  expect(await service.cached(source)).toEqual([])
})
it('rejects unsafe ranges and unknown parts before starting processes', async () => {
  const { dir, source } = await setup(), service = createAnalysisService(dir)
  await expect(service.run(source, { range: { start: .5, end: FLICKS } })).rejects.toThrow('integer flicks')
  await expect(service.run(source, { range: { start: 0, end: 11 * FLICKS } })).rejects.toThrow('within source')
  await expect(service.run(source, { parts: ['unknown' as never] })).rejects.toThrow('Invalid analysis parts')
})
it('keeps only one analysis job active and releases ownership after failure', async () => {
  const { dir, source } = await setup(), service = createAnalysisService(dir)
  const first = service.run(source, { parts: ['shots'] })
  await expect(service.run(source, { parts: [] })).rejects.toThrow('already running')
  await first
  expect((await service.run(source, { parts: [] })).parts).toEqual([])
})
