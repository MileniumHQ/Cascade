import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscriptionService, DEFAULT_MODEL } from './transcribe'

const state = vi.hoisted(() => ({ calls: [] as string[][], failCPU: false, onGPU: undefined as (() => void) | undefined }))
vi.mock('./ffmpeg', () => ({
  capture: async () => ({ stderr: 'ggml_vulkan: Found 1 Vulkan devices', stdout: '', code: 0 }),
  getFFmpegTools: async () => ({ ffmpeg: 'ffmpeg' }),
  spawnTracked: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: { resume() {} }, kill() {} })
    queueMicrotask(async () => {
      if (command === 'ffmpeg') { child.emit('close', 0); return }
      state.calls.push(args)
      if (!args.includes('-ng')) state.onGPU?.()
      if (!args.includes('-ng') || state.failCPU) { child.emit('close', null); return }
      await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [] }))
      child.emit('close', 0)
    })
    return child
  }
}))

let root: string
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
async function setup() {
  vi.stubEnv('CASCADE_WHISPER_CPU', '0')
  state.calls = []; state.failCPU = false; state.onGPU = undefined
  root = await mkdtemp(join(tmpdir(), 'cascade-transcribe-test-'))
  const bin = join(root, 'whisper', `${process.platform}-${process.arch}`)
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'), '', { mode: 0o755 })
  await mkdir(join(root, 'models'))
  // Sparse fixtures satisfy discovery without downloading or allocating model data.
  for (const [name, size] of [[DEFAULT_MODEL, 874188075], ['ggml-silero-v6.2.0.bin', 885098]] as const) {
    const file = await open(join(root, 'models', name), 'w')
    await file.truncate(size); await file.close()
  }
  const path = join(root, 'source.wav')
  await writeFile(path, '')
  return { service: createTranscriptionService(root, root), path }
}

it('retries a failed GPU process once on CPU and keeps subsequent jobs on CPU', async () => {
  const { service, path } = await setup()
  const messages: string[] = []
  service.onProgress(p => messages.push(p.message))
  await service.run(path, { language: 'en' })
  await service.run(path, { language: 'fr' })
  expect(state.calls.map(args => args.includes('-ng'))).toEqual([false, true, true])
  expect(messages).toContain('GPU transcription failed; retrying on CPU')
  expect((await service.status()).gpu).toBe(false)
})

it('surfaces a failed CPU retry without looping', async () => {
  const { service, path } = await setup()
  state.failCPU = true
  await expect(service.run(path)).rejects.toThrow(/failed/)
  expect(state.calls.map(args => args.includes('-ng'))).toEqual([false, true])
})

it('does not retry a GPU process killed by cancellation', async () => {
  const { service, path } = await setup()
  state.onGPU = () => { void service.cancel() }
  await expect(service.run(path)).rejects.toThrow(/cancelled/)
  expect(state.calls.map(args => args.includes('-ng'))).toEqual([false])
})

it('can start directly on CPU without first launching GPU inference', async () => {
  const { path } = await setup()
  vi.stubEnv('CASCADE_WHISPER_CPU', '1')
  const service = createTranscriptionService(root, root)
  await service.run(path)
  expect(state.calls.map(args => args.includes('-ng'))).toEqual([true])
  expect((await service.status()).gpu).toBe(false)
})
