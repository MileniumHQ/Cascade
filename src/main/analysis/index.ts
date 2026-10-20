import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ANALYSIS_VERSION, type AnalysisBridge, type AnalysisOptions, type AnalysisPart, type AnalysisProgress, type SourceAnalysis } from '../../shared/analysis'
import { FLICKS } from '../../shared/time'
import { createTranscriptionService } from '../transcribe'
import { createMediaService } from '../media'
import { getFFmpegTools, spawnTracked } from '../ffmpeg'
import { downloadModel, size } from '../model-download'
import { MODELS } from './models'
import { applyLoudness, applyProsody, cacheKey, completePart, EventMerger, isFiller, PITCH_HOP_SAMPLES, sentences } from './logic'

const PARTS: AnalysisPart[] = ['speech', 'events', 'prosody', 'shots', 'speakers']
const RATE = 16000
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
type TranscriptionService = ReturnType<typeof createTranscriptionService>

/** Drain stderr incrementally; retain only the tail for errors. Abort always kills the child. */
async function execute(command: string, args: string[], signal: AbortSignal, line?: (line: string) => void) {
  signal.throwIfAborted()
  const child = spawnTracked(command, args)
  const kill = () => { child.kill('SIGKILL') }
  signal.addEventListener('abort', kill, { once: true })
  let tail = '', pending = ''
  child.stdout!.resume()
  child.stderr!.on('data', (buffer: Buffer) => {
    const text = buffer.toString(); tail = (tail + text).slice(-8192)
    pending += text
    const lines = pending.split(/[\r\n]/); pending = lines.pop() ?? ''
    for (const text of lines) line?.(text)
  })
  try {
    await new Promise<void>((yes, no) => {
      child.once('error', no)
      child.once('close', code => code === 0 ? yes() : no(new Error(`${command} failed (${code}): ${tail}`)))
    })
    if (pending) line?.(pending)
    signal.throwIfAborted()
  } finally { signal.removeEventListener('abort', kill) }
}

function inference(part: 'events' | 'prosody', modelsDir: string, language: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const worker = new Worker(fileURLToPath(new URL('./analysis-worker.js', import.meta.url)))
  const cancel = () => { void worker.terminate() }
  signal.addEventListener('abort', cancel, { once: true })
  let closed = false
  let failure: Error | undefined
  let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
  worker.on('error', error => { failure = error instanceof Error ? error : new Error(String(error)); pending?.reject(failure); pending = undefined })
  worker.on('exit', code => {
    closed = true
    failure ??= new Error(signal.aborted ? 'Analysis cancelled' : `Inference worker exited (${code})`)
    pending?.reject(failure); pending = undefined
  })
  worker.on('message', (reply: { result?: unknown; error?: string }) => {
    if (reply.error) pending?.reject(new Error(reply.error))
    else pending?.resolve(reply.result)
    pending = undefined
  })
  const request = (payload: unknown): Promise<unknown> => {
    signal.throwIfAborted()
    if (failure || closed) return Promise.reject(failure ?? new Error('Inference worker closed'))
    return new Promise((resolve, reject) => { pending = { resolve, reject }; worker.postMessage(payload) })
  }
  return { ready: () => request({ kind: 'init', part, modelsDir, language }), request,
    close: async () => { signal.removeEventListener('abort', cancel); await worker.terminate() } }
}

export function createAnalysisService(userData: string, resourcesPath = process.resourcesPath, transcription: TranscriptionService = createTranscriptionService(userData, resourcesPath)): AnalysisBridge {
  const modelsDir = join(userData, 'models'), cacheDir = join(userData, 'cache', 'analysis')
  const media = createMediaService(join(userData, 'cache'))
  const listeners = new Set<(progress: AnalysisProgress) => void>()
  let current: AbortController | undefined, activePath = '', usingTranscription = false
  const emit = (part: AnalysisProgress['part'], progress: number, text: string, phase: AnalysisProgress['phase'] = 'running') => {
    for (const listener of listeners) listener({ path: activePath, part, progress: Math.max(0, Math.min(1, progress)), message: text, phase })
  }
  transcription.onProgress(p => { if (current && usingTranscription) emit(p.phase === 'download' ? 'download' : p.phase === 'extract' ? 'extract' : 'speech', p.progress, p.message, p.phase === 'error' || p.phase === 'cancelled' ? p.phase : 'running') })
  const installed = async (m: typeof MODELS[number]) => (await Promise.all(m.files.map(f => size(join(modelsDir, m.directory, f))))).every((n, i) => n === m.fileSizes[i])
  async function status() {
    const speech = await transcription.status()
    const available: AnalysisPart[] = []
    // Shots need only ffmpeg; prosody needs only decoded audio and a speech result.
    if (await getFFmpegTools().then(() => true, () => false)) available.push('prosody', 'shots')
    const missing = speech.models.filter(m => !m.installed).map(m => ({ part: 'speech' as AnalysisPart, id: m.id, name: m.name, sizeBytes: m.sizeBytes }))
    if (speech.binary && !missing.length) available.unshift('speech')
    // The pinned Linux addon is packaged as a dependency; model presence is checked independently.
    let runtime = false
    if (process.platform === 'linux' && process.arch === 'x64') {
      try { createRequire(import.meta.url).resolve('sherpa-onnx-linux-x64/sherpa-onnx.node'); runtime = true } catch { /* Native package missing. */ }
    }
    for (const model of MODELS) {
      if (await installed(model)) { if (runtime) available.push(model.part) }
      else missing.push({ part: model.part, id: model.id, name: model.name, sizeBytes: model.sizeBytes })
    }
    return { available, missing }
  }
  function validateParts(parts: AnalysisPart[]) {
    if (!Array.isArray(parts) || parts.some(p => !PARTS.includes(p))) throw new Error('Invalid analysis parts')
    return [...new Set(parts)]
  }
  async function exclusive<T>(path: string, work: (signal: AbortSignal) => Promise<T>) {
    if (current) throw new Error('Analysis is already running')
    const controller = new AbortController(); current = controller; activePath = path
    try { return await work(controller.signal) }
    catch (error) { if (controller.signal.aborted) emit('extract', 0, 'Analysis cancelled', 'cancelled'); throw error }
    finally { current = undefined; activePath = '' }
  }
  async function installModels(parts: AnalysisPart[] = ['speech', 'events']) {
    const requested = validateParts(parts)
    return exclusive('', async signal => {
      await mkdir(modelsDir, { recursive: true })
      if (requested.includes('speech')) {
        for (const m of (await transcription.status()).models) {
          signal.throwIfAborted()
          usingTranscription = true
          try { await transcription.installModel(m.id) } finally { usingTranscription = false }
          signal.throwIfAborted()
        }
      }
      for (const model of MODELS.filter(m => requested.includes(m.part))) {
        signal.throwIfAborted()
        if (await installed(model)) {
          await writeFile(join(modelsDir, model.directory, 'NOTICE.txt'), model.notice + '\n')
          continue
        }
        const archive = join(modelsDir, `${model.id}.tar.bz2`)
        await downloadModel(model, archive, signal, (p, text) => emit('download', p, text))
        const temp = await mkdtemp(join(modelsDir, '.extract-'))
        try {
          // Fixed release archives, verified before extraction; extract only required members.
          await execute('tar', ['-xjf', archive, '-C', temp, ...model.files.map(f => `${model.directory}/${f}`)], signal)
          signal.throwIfAborted()
          await rm(join(modelsDir, model.directory), { recursive: true, force: true })
          await writeFile(join(temp, model.directory, 'NOTICE.txt'), model.notice + '\n')
          await rename(join(temp, model.directory), join(modelsDir, model.directory))
          emit('download', 1, `${model.name} installed`, 'done')
        } finally { await rm(temp, { recursive: true, force: true }) }
      }
    })
  }
  async function cached(path: string) {
    const absolute = resolve(path), info = await stat(absolute)
    const results: SourceAnalysis[] = []
    for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const entry = JSON.parse(await readFile(join(cacheDir, name), 'utf8')) as { mtime: number; size: number; result: SourceAnalysis }
        if (entry.mtime === info.mtimeMs && entry.size === info.size && entry.result.path === absolute && entry.result.version === ANALYSIS_VERSION) results.push(entry.result)
      } catch { /* Ignore corrupt and unfinished cache entries. */ }
    }
    return results
  }
  async function run(path: string, opts: AnalysisOptions = {}) {
    if (typeof path !== 'string' || !path) throw new Error('A source file path is required')
    return exclusive(resolve(path), async signal => {
      const absolute = resolve(path), info = await stat(absolute)
      if (!info.isFile()) throw new Error('Analysis source must be a file')
      const meta = await media.probe(absolute)
      if (meta.error) throw new Error(meta.error)
      const range = opts.range ?? { start: 0, end: meta.duration ?? 0 }
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || meta.duration !== undefined && range.end > meta.duration) throw new Error('Invalid source range (expected integer flicks within source duration)')
      const language = opts.language ?? 'auto'
      if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('Invalid analysis language')
      const requested = validateParts(opts.parts ?? (await status()).available)
      // Prosody is measured per word and sentence, so speech is an explicit completed dependency.
      if (requested.includes('prosody') && !requested.includes('speech')) requested.unshift('speech')
      const key = cacheKey(absolute, info, range, language, requested)
      await mkdir(cacheDir, { recursive: true })
      const cache = join(cacheDir, `${key}.json`)
      try {
        const entry = JSON.parse(await readFile(cache, 'utf8')) as { result: SourceAnalysis }
        if (!entry.result.errors && entry.result.version === ANALYSIS_VERSION) { emit('extract', 1, 'Loaded cached analysis', 'done'); return entry.result }
      } catch { /* Cache miss. Partial failures are retried on the next run. */ }
      const result: SourceAnalysis = { version: ANALYSIS_VERSION, path: absolute, range, language, parts: [], models: {}, words: [], sentences: [], events: [], silences: [], shots: [] }
      const temp = await mkdtemp(join(cacheDir, '.work-'))
      const pcm = join(temp, 'audio.f32')
      let pcmReady = false
      const { ffmpeg } = await getFFmpegTools()
      const input = ['-ss', String(range.start / FLICKS), '-t', String((range.end - range.start) / FLICKS), '-threads', '4', '-i', absolute]
      const extract = async () => {
        if (pcmReady) return
        if (!meta.hasAudio) throw new Error('Source has no audio stream')
        emit('extract', 0, 'Decoding mono 16 kHz PCM to disk')
        const silences: SourceAnalysis['silences'] = []
        let silenceStart: number | undefined
        await execute(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-y', ...input, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-af', 'silencedetect=noise=-35dB:d=0.18', '-threads', '4', '-f', 'f32le', pcm], signal, line => {
          const start = line.match(/silence_start: (-?[\d.]+)/), end = line.match(/silence_end: (-?[\d.]+)/)
          const time = (s: string) => Math.max(range.start, Math.min(range.end, range.start + Math.round(Number(s) * FLICKS)))
          if (start) silenceStart = time(start[1])
          if (end && silenceStart !== undefined) { silences.push({ start: silenceStart, end: time(end[1]) }); silenceStart = undefined }
        })
        if (silenceStart !== undefined) silences.push({ start: silenceStart, end: range.end })
        result.silences = silences; pcmReady = true
        emit('extract', 1, 'PCM ready', 'done')
      }
      const audio = async (work: (read: (start: number, end: number) => Promise<Float32Array>, frames: number) => Promise<void>) => {
        await extract()
        const file = await open(pcm, 'r'), frames = Math.floor((await file.stat()).size / 4)
        const read = async (start: number, end: number) => {
          signal.throwIfAborted()
          const from = Math.max(0, Math.round((start - range.start) / FLICKS * RATE))
          const to = Math.min(frames, Math.round((end - range.start) / FLICKS * RATE))
          if (to - from > RATE * 31) throw new Error('Audio window exceeds memory bound')
          const samples = new Float32Array(Math.max(0, to - from))
          const buffer = Buffer.from(samples.buffer)
          let bytes = 0
          while (bytes < buffer.length) {
            const n = (await file.read(buffer, bytes, buffer.length - bytes, from * 4 + bytes)).bytesRead
            if (!n) break
            bytes += n
          }
          return samples.subarray(0, bytes / 4)
        }
        try { await work(read, frames) } finally { await file.close() }
      }
      const work: Partial<Record<AnalysisPart, () => Promise<void>>> = {
        speech: async () => {
          usingTranscription = true
          let transcript: Awaited<ReturnType<TranscriptionService['run']>>
          try { transcript = await transcription.run(absolute, { range, language, verbatim: true }) } finally { usingTranscription = false }
          const words = transcript.segments.flatMap(s => s.words).map(w => ({ ...w, ...(isFiller(w.text) ? { filler: true } : {}) }))
          await audio(async read => {
            const energy = words.map(() => ({ sum: 0, count: 0 }))
            for (let start = range.start; start < range.end; start += 30 * FLICKS) {
              const end = Math.min(range.end, start + 30 * FLICKS), samples = await read(start, end)
              for (let i = 0; i < words.length; i++) {
                const from = Math.max(0, Math.round((words[i].start - start) / FLICKS * RATE)), to = Math.min(samples.length, Math.round((words[i].end - start) / FLICKS * RATE))
                for (let j = from; j < to; j++) { energy[i].sum += samples[j] * samples[j]; energy[i].count++ }
              }
            }
            result.speechDb = applyLoudness(words, energy)
          })
          result.words = words; result.sentences = sentences(words); result.language = transcript.language
          result.models.speech = `${transcript.model}; verbatim-prompt-v1`
        },
        events: async () => {
          const model = MODELS.find(m => m.part === 'events')!
          if (!await installed(model)) throw new Error('CED-Mini model missing; call installModels(["events"])')
          const worker = inference('events', modelsDir, language, signal), merger = new EventMerger()
          try {
            await worker.ready()
            await audio(async (read, frames) => {
              const end = Math.min(range.end, range.start + Math.round(frames / RATE * FLICKS))
              for (let start = range.start; start < end; start += FLICKS) {
                const finish = Math.min(end, start + 2 * FLICKS)
                if (finish - start < .5 * FLICKS) break
                const tags = await worker.request({ kind: 'events', samples: await read(start, finish) }) as { name: string; prob: number }[]
                merger.push({ start, end: finish, tags })
                emit('events', (finish - range.start) / (range.end - range.start), 'Classifying sound windows')
              }
            })
            result.events = merger.finish(result.words); result.models.events = model.id
          } finally { await worker.close() }
        },
        prosody: async () => {
          if (!result.parts.includes('speech')) throw new Error('Prosody requires successful speech analysis')
          const worker = inference('prosody', modelsDir, language, signal)
          const f0: number[][] = result.words.map(() => [])
          try {
            await worker.ready()
            await audio(async read => {
              const hop = FLICKS * PITCH_HOP_SAMPLES / RATE
              for (let start = range.start; start < range.end; start += 30 * FLICKS) {
                const end = Math.min(range.end, start + 30 * FLICKS)
                const inside = result.words.map((w, i) => [w, i] as const).filter(([w]) => w.end > start && w.start < end)
                if (!inside.length) continue
                const spans = inside.map(([w]) => [Math.floor((w.start - start) / hop), Math.ceil((w.end - start) / hop)] as [number, number])
                const track = await worker.request({ kind: 'pitch', samples: await read(start, end), spans }) as Float32Array
                inside.forEach(([w, i]) => {
                  for (let h = Math.max(0, Math.ceil((w.start - start) / hop)); h < Math.min(track.length, Math.floor((w.end - start) / hop)); h++) if (track[h]) f0[i].push(track[h])
                })
                emit('prosody', (end - range.start) / (range.end - range.start), 'Measuring pitch and emphasis')
              }
            })
            result.speechHz = applyProsody(result.words, result.sentences, f0)
            result.models.prosody = 'yin-8k-60-400hz-v1'
          } finally { await worker.close() }
        },
        shots: async () => {
          if (!meta.hasVideo) throw new Error('Source has no video stream')
          const shots: number[] = []
          await execute(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', ...input, '-an', '-vf', "scale=320:-2,select='gt(scene,0.30)',showinfo", '-threads', '4', '-filter_threads', '1', '-fps_mode', 'vfr', '-f', 'null', '-'], signal, line => {
            const match = line.match(/\bn:\s*\d+.*?pts_time:([\d.]+)/)
            if (!match) return
            const at = range.start + Math.round(Number(match[1]) * FLICKS)
            if (at > range.start && at < range.end && (!shots.length || at - shots.at(-1)! > .15 * FLICKS)) shots.push(at)
            emit('shots', (at - range.start) / (range.end - range.start), 'Detecting hard cuts')
          })
          result.shots = shots; result.models.shots = 'ffmpeg-scene-0.30-scale320-cpu'
        },
        speakers: async () => { throw new Error('Speaker diarization is not installed (stretch feature)') }
      }
      try {
        for (const part of PARTS.filter(p => requested.includes(p))) {
          emit(part, 0, `Starting ${part}`)
          await completePart(result, part, work[part]!, signal)
          emit(part, 1, result.errors?.[part] ?? `${part} ready`, result.errors?.[part] ? 'error' : 'done')
        }
        signal.throwIfAborted()
        const staging = join(temp, 'cache.json')
        await writeFile(staging, JSON.stringify({ mtime: info.mtimeMs, size: info.size, result }))
        await rename(staging, cache)
        return result
      } finally { await rm(temp, { recursive: true, force: true }) }
    })
  }
  return { status, installModels, run, cached,
    cancel: async () => { current?.abort(); if (usingTranscription) await transcription.cancel() },
    onProgress(fn) { listeners.add(fn); return () => { listeners.delete(fn) } } }
}

export async function registerAnalysisIpc(userData: string, transcription?: TranscriptionService) {
  const { ipcMain, app } = await import('electron')
  const service = createAnalysisService(userData, process.resourcesPath, transcription)
  let owner: Electron.WebContents | undefined
  const withOwner = async <T>(sender: Electron.WebContents, work: () => Promise<T>) => {
    if (owner) throw new Error('Analysis is already running')
    owner = sender
    const cancel = () => { void service.cancel() }
    sender.once('destroyed', cancel)
    try { return await work() } finally { sender.removeListener('destroyed', cancel); owner = undefined }
  }
  service.onProgress(p => { if (owner && !owner.isDestroyed()) owner.send('analysis:progress', p) })
  ipcMain.handle('analysis:status', () => service.status())
  ipcMain.handle('analysis:cached', (_event, path: string) => service.cached(path))
  ipcMain.handle('analysis:run', (event, path: string, opts?: AnalysisOptions) => withOwner(event.sender, () => service.run(path, opts)))
  ipcMain.handle('analysis:installModels', (event, parts?: AnalysisPart[]) => withOwner(event.sender, () => service.installModels(parts)))
  ipcMain.handle('analysis:cancel', event => { if (owner === event.sender) return service.cancel() })
  app.on('before-quit', () => { void service.cancel() })
  return service
}
