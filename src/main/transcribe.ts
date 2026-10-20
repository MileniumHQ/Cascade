import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import type { Transcript, TranscriptWord, TranscribeOptions, TranscribeProgress, TranscribeStatus } from '../shared/ipc'
import { FLICKS } from '../shared/time'
import { capture, getFFmpegTools, spawnTracked } from './ffmpeg'

export const DEFAULT_MODEL = 'ggml-large-v3-turbo-q8_0.bin'
const VAD_MODEL = 'ggml-silero-v6.2.0.bin'
const MODELS = [
  { id: DEFAULT_MODEL, name: 'Whisper Large v3 Turbo Q8', sizeBytes: 874188075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/0b364b566045a405be7225ee1e415a073e04da77/ggml-large-v3-turbo-q8_0.bin' },
  { id: VAD_MODEL, name: 'Silero VAD 6.2', sizeBytes: 885098,
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin' }
] as const
const VERSION = 'v1.9.5-vad-dtw-acoustic-4'

interface WhisperToken { text: string; id: number; p: number; t_dtw?: number; offsets?: { from: number; to: number } }
interface WhisperJSON {
  result?: { language?: string }
  transcription: { text: string; offsets: { from: number; to: number }; tokens: WhisperToken[] }[]
}

/** DTW is in centiseconds; JSON offsets are milliseconds. BPE pieces are not words. */
export function parseWhisperJSON(json: WhisperJSON, path: string, model: string, offset = 0, end = Number.MAX_SAFE_INTEGER): Transcript {
  if (!Array.isArray(json.transcription)) throw new Error('Invalid whisper full JSON: missing transcription')
  const f = (ms: number) => Math.min(end, Math.max(offset, offset + Math.round(ms * FLICKS / 1000)))
  // Use DTW word onsets, regular token offsets for the final end (DTW has no end field).
  const tokens = json.transcription.flatMap((segment) => segment.tokens.filter((t) => t.id < 50257 && t.text && !t.text.startsWith('[_')))
  const groups: WhisperToken[][] = []
  for (const token of tokens) {
    if (!groups.length || /^\s/.test(token.text)) groups.push([token])
    else groups[groups.length - 1].push(token)
  }
  const onset = (t: WhisperToken) => typeof t.t_dtw === 'number' && t.t_dtw >= 0 ? t.t_dtw * 10 : t.offsets?.from
  const rawOnsets = groups.map((g) => onset(g[0]))
  // A failed DTW path can collapse several words onto one timestamp. Use the
  // separately estimated token offsets for that run rather than zero-length words.
  const onsets = groups.map((g, i) => {
    const ms = rawOnsets[i]
    const previous = rawOnsets[i - 1], next = rawOnsets[i + 1]
    const collapsed = ms !== undefined && ((previous !== undefined && ms <= previous) || (next !== undefined && ms >= next))
    return collapsed && g[0].offsets ? g[0].offsets.from : ms
  })
  const words: TranscriptWord[] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const ms = onsets[i]
    const last = group[group.length - 1]
    if (ms === undefined || !Number.isFinite(ms)) throw new Error('Whisper did not produce word timestamps')
    const next = onsets[i + 1]
    const tokenEnd = last.offsets?.to ?? (ms + 100)
    // Legacy token ends often precede DTW onsets. Use the next word anchor,
    // bounded for long gaps; acoustic silence below trims sentence endings.
    const endMs = Math.max(ms + 10, next !== undefined && next > ms ? Math.min(next, Math.max(ms + 700, tokenEnd)) : tokenEnd)
    const start = Math.max(words.at(-1)?.start ?? offset, f(ms))
    const finish = Math.max(start, f(endMs))
    const text = group.map((t) => t.text).join('').trim()
    if (text && start < end) words.push({ text, start, end: finish, p: Math.min(...group.map((t) => Number.isFinite(t.p) ? t.p : 0)) })
  }
  // Segment boundaries are derived from the actual words rather than VAD's segment interpolation.
  const segments: Transcript['segments'] = []
  let pending: TranscriptWord[] = []
  const flush = () => {
    if (pending.length) segments.push({ text: pending.map((w) => w.text).join(' '), start: pending[0].start, end: pending.at(-1)!.end, words: pending })
    pending = []
  }
  for (const word of words) {
    if (pending.length && (word.start - pending.at(-1)!.end > FLICKS * 0.6 || pending.length >= 30)) flush()
    pending.push(word)
    if (/[.!?]["'’”]?$/.test(word.text)) flush()
  }
  flush()
  return { path, model, language: json.result?.language ?? 'auto', segments }
}

/** Acoustic pauses constrain DTW's uncertain sentence edges. Times are source flicks. */
export function constrainToSpeech(transcript: Transcript, silences: { start: number; end: number }[]): Transcript {
  const words = transcript.segments.flatMap((s) => s.words)
  let cursor = 0
  for (const word of words) {
    while (cursor < silences.length && silences[cursor].end < word.start) cursor++
    for (let i = Math.max(0, cursor - 1); i < silences.length && silences[i].start < word.end; i++) {
      const silence = silences[i]
      if (silence.start > word.start) { word.end = Math.min(word.end, silence.start); break }
    }
  }
  cursor = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    while (cursor < silences.length && silences[cursor].end <= word.start) cursor++
    const before = silences[cursor - 1]
    if (before && word.start - before.end <= FLICKS * 0.35 && (i === 0 || words[i - 1].end <= before.start)) {
      word.start = Math.min(word.start, before.end)
    }
    if (i) words[i - 1].end = Math.min(words[i - 1].end, word.start)
  }
  for (const segment of transcript.segments) {
    segment.start = segment.words[0].start
    segment.end = segment.words.at(-1)!.end
  }
  return transcript
}

async function size(path: string) { return (await stat(path).catch(() => null))?.size ?? 0 }
async function sha256(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function createTranscriptionService(userData: string, resourcesPath = process.resourcesPath) {
  const modelsDir = join(userData, 'models')
  const cacheDir = join(userData, 'cache/transcripts')
  let current: AbortController | undefined
  let gpuProbe: { path: string; result: Promise<boolean> } | undefined
  const listeners = new Set<(p: TranscribeProgress) => void>()
  const emit = (p: TranscribeProgress) => { for (const listener of listeners) listener(p) }
  async function binaryPath() {
    const platform = `${process.platform}-${process.arch}`
    const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    const candidates = [resourcesPath && join(resourcesPath, 'whisper', platform, exe),
      resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/whisper', platform, exe),
      resolve('resources/whisper', platform, exe)].filter((p): p is string => !!p)
    for (const path of candidates) {
      try { await access(path, constants.X_OK); return path } catch { /* Try development resources. */ }
    }
    return null
  }
  async function status(): Promise<TranscribeStatus> {
    const binary = await binaryPath()
    // An existing invalid model reaches backend discovery without allocating model memory.
    if (binary && gpuProbe?.path !== binary) gpuProbe = { path: binary, result: capture(binary, ['-m', binary, '-f', binary], 15_000)
      .then((p) => /ggml_vulkan: Found [1-9]\d* Vulkan devices?/.test(p.stderr)).catch(() => false) }
    return { binary: !!binary, gpu: binary && gpuProbe ? await gpuProbe.result : false, models: await Promise.all(MODELS.map(async (m) => ({ id: m.id, name: m.name,
      sizeBytes: m.sizeBytes, installed: await size(join(modelsDir, m.id)) === m.sizeBytes }))) }
  }
  async function install(id: string, signal: AbortSignal) {
    const model = MODELS.find((m) => m.id === id)
    if (!model) throw new Error(`Unknown transcription model: ${id}`)
    await mkdir(modelsDir, { recursive: true })
    const target = join(modelsDir, id)
    if (await size(target) === model.sizeBytes) return
    const partial = `${target}.partial`
    let offset = await size(partial)
    if (offset > model.sizeBytes) { await rm(partial); offset = 0 }
    if (offset < model.sizeBytes) {
      const response = await fetch(model.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal })
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`)
      if (response.status === 206) {
        if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Invalid model download resume offset')
      } else offset = 0 // Server ignored Range: replace the partial file.
      const file = await open(partial, offset ? 'a' : 'w')
      let last = 0
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          await file.writeFile(chunk)
          offset += chunk.length
          if (Date.now() - last > 250) {
            last = Date.now()
            emit({ phase: 'download', progress: Math.min(1, offset / model.sizeBytes), model: id, bytes: offset, totalBytes: model.sizeBytes, message: `Downloading ${model.name}` })
          }
        }
      } finally { await file.close() }
    }
    signal.throwIfAborted()
    emit({ phase: 'download', progress: 1, model: id, message: `Verifying ${model.name}` })
    if (await size(partial) !== model.sizeBytes || await sha256(partial) !== model.sha256) {
      await rm(partial, { force: true })
      throw new Error(`Model checksum mismatch: ${id}. Retry the download.`)
    }
    signal.throwIfAborted()
    await rename(partial, target)
  }
  async function exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (current) throw new Error('Captioning is already running. Cancel it before starting another job.')
    const controller = new AbortController()
    current = controller
    try { return await work(controller.signal) } catch (error) {
      emit({ phase: controller.signal.aborted ? 'cancelled' : 'error', progress: 0,
        message: controller.signal.aborted ? 'Captioning cancelled' : String(error) })
      throw controller.signal.aborted ? new Error('Captioning cancelled') : error
    } finally { current = undefined }
  }
  async function execute(command: string, args: string[], signal: AbortSignal, progress?: (s: string) => void) {
    signal.throwIfAborted()
    const child = spawnTracked(command, args)
    let stderr = ''
    const kill = () => child.kill('SIGKILL')
    signal.addEventListener('abort', kill, { once: true })
    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr = (stderr + text).slice(-32_000)
      progress?.(text)
    })
    child.stdout!.resume()
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command.split(/[\\/]/).at(-1)} failed (${code}): ${stderr}`)))
      })
      signal.throwIfAborted()
    } finally { signal.removeEventListener('abort', kill) }
  }
  async function run(path: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    return exclusive(async (signal) => {
      if (typeof path !== 'string' || !path) throw new Error('A source file path is required')
      const range = opts.range
      if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start)) throw new Error('Invalid source range (expected integer flicks)')
      const model = opts.model ?? DEFAULT_MODEL
      if (model !== DEFAULT_MODEL) throw new Error(`Unsupported transcription model: ${model}`)
      const language = opts.language ?? 'auto'
      if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('Invalid transcription language')
      const binary = await binaryPath()
      if (!binary) throw new Error('whisper-cli is missing. Run bun run setup:whisper, then retry.')
      const source = await stat(path)
      if (!source.isFile()) throw new Error('The transcription source must be a file')
      const key = createHash('sha256').update(JSON.stringify([VERSION, resolve(path), source.mtimeMs, source.size, range, model, language])).digest('hex')
      await mkdir(cacheDir, { recursive: true })
      const cached = join(cacheDir, `${key}.json`)
      try {
        const transcript = JSON.parse(await readFile(cached, 'utf8')) as Transcript
        if (Array.isArray(transcript.segments)) { emit({ phase: 'done', progress: 1, message: 'Loaded cached transcript' }); return transcript }
      } catch { /* Cache miss or interrupted cache write. */ }
      await install(model, signal)
      await install(VAD_MODEL, signal)
      const temp = await mkdtemp(join(cacheDir, '.work-'))
      try {
        const wav = join(temp, 'audio.wav')
        const { ffmpeg } = await getFFmpegTools()
        emit({ phase: 'extract', progress: 0, message: 'Extracting 16 kHz mono audio' })
        const silences: { start: number; end: number }[] = []
        let silenceStart: number | undefined
        let audioLog = ''
        const sourceTime = (seconds: number) => Math.round(seconds * FLICKS) + (range?.start ?? 0)
        await execute(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-y',
          ...(range ? ['-ss', String(range.start / FLICKS)] : []), '-i', path,
          ...(range ? ['-t', String((range.end - range.start) / FLICKS)] : []),
          '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-af', 'silencedetect=noise=-35dB:d=0.18', '-c:a', 'pcm_s16le', wav], signal, (text) => {
          audioLog += text
          const lines = audioLog.split('\n')
          audioLog = lines.pop() ?? ''
          for (const line of lines) {
            const start = line.match(/silence_start: ([\d.]+)/)
            const end = line.match(/silence_end: ([\d.]+)/)
            if (start) silenceStart = sourceTime(Number(start[1]))
            if (end && silenceStart !== undefined) { silences.push({ start: silenceStart, end: sourceTime(Number(end[1])) }); silenceStart = undefined }
          }
        })
        emit({ phase: 'transcribe', progress: 0, message: 'Aligning speech and words locally' })
        let progressBuffer = ''
        await execute(binary, ['-m', join(modelsDir, model), '-f', wav, '-l', language, '--vad', '-vm', join(modelsDir, VAD_MODEL),
          '--dtw', 'large.v3.turbo', '--no-flash-attn', '-ojf', '--split-on-word', '-pp', '-of', join(temp, 'transcript'),
          '-t', String(Math.min(8, availableParallelism()))], signal, (text) => {
          progressBuffer = (progressBuffer + text).slice(-1024)
          const matches = [...progressBuffer.matchAll(/progress\s*=\s*(\d+)%/g)]
          if (matches.length) { const percent = Number(matches.at(-1)![1]); emit({ phase: 'transcribe', progress: percent / 100, message: `Aligning speech and words · ${percent}%` }); progressBuffer = '' }
        })
        const json = JSON.parse(await readFile(join(temp, 'transcript.json'), 'utf8')) as WhisperJSON
        const transcript = constrainToSpeech(parseWhisperJSON(json, path, model, range?.start, range?.end), silences)
        signal.throwIfAborted()
        const staging = join(temp, 'cache.json')
        await writeFile(staging, JSON.stringify(transcript))
        await rename(staging, cached)
        emit({ phase: 'done', progress: 1, message: 'Transcript ready' })
        return transcript
      } finally { await rm(temp, { recursive: true, force: true }) }
    })
  }
  return { status, run, installModel: (id: string) => exclusive((signal) => install(id, signal)),
    cancel: async () => { current?.abort() },
    onProgress(fn: (p: TranscribeProgress) => void) { listeners.add(fn); return () => { listeners.delete(fn) } } }
}

/** One application-wide job; progress is sent only to the requesting renderer. */
export async function registerTranscribeIpc(userData: string) {
  const { ipcMain, app } = await import('electron')
  const service = createTranscriptionService(userData)
  let owner: Electron.WebContents | undefined
  const withOwner = async <T>(sender: Electron.WebContents, work: () => Promise<T>) => {
    if (owner) throw new Error('Captioning is already running')
    owner = sender
    const cancel = () => { void service.cancel() }
    sender.once('destroyed', cancel)
    try { return await work() } finally { sender.removeListener('destroyed', cancel); owner = undefined }
  }
  service.onProgress((p) => { if (owner && !owner.isDestroyed()) owner.send('transcribe:progress', p) })
  ipcMain.handle('transcribe:status', () => service.status())
  ipcMain.handle('transcribe:installModel', (event, id: string) => withOwner(event.sender, () => service.installModel(id)))
  ipcMain.handle('transcribe:run', (event, path: string, opts?: TranscribeOptions) => withOwner(event.sender, () => service.run(path, opts)))
  ipcMain.handle('transcribe:cancel', (event) => { if (owner === event.sender) return service.cancel() })
  app.on('before-quit', () => { void service.cancel() })
}
