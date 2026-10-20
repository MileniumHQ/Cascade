/**
 * The bridge between renderer and main process, exposed by the preload as `window.cascade`.
 * Everything that needs Node / the OS lives behind this interface.
 */
import type { MediaMeta, Project } from './project'
import type { Flicks, FrameRate } from './time'

/** All transcript times are integer flicks in the original source media. */
export interface TranscriptWord {
  text: string
  start: Flicks
  end: Flicks
  p: number
}
export interface TranscriptSegment {
  text: string
  start: Flicks
  end: Flicks
  words: TranscriptWord[]
}
export interface Transcript {
  path: string
  model: string
  language: string
  segments: TranscriptSegment[]
}
export interface TranscribeOptions {
  range?: { start: Flicks; end: Flicks }
  language?: string
  model?: string
}
export interface TranscribeProgress {
  phase: 'download' | 'extract' | 'transcribe' | 'done' | 'cancelled' | 'error'
  progress: number
  message: string
  model?: string
  bytes?: number
  totalBytes?: number
}
export interface TranscribeStatus {
  binary: boolean
  /** A GPU device was detected by the bundled Vulkan backend. */
  gpu: boolean
  models: { id: string; name: string; sizeBytes: number; installed: boolean }[]
}

export interface ThumbnailStrip {
  /** URL pattern; replace `{i}` with the thumbnail index (0-based). */
  urlPattern: string
  /** Seconds between thumbnails. */
  interval: number
  count: number
  width: number
  height: number
  /** True while still generating (more may appear; poll again). */
  partial: boolean
}

export interface WaveformData {
  /** Peaks per second of source audio. */
  rate: number
  /** Interleaved min/max pairs, normalized to -1..1, as a URL to a Float32 binary file. */
  url: string
  length: number
}

export interface ExportRequest {
  project: Project
  timelineId: string
  width: number
  height: number
  fps: FrameRate
  range: { start: Flicks; end: Flicks }
  output: string
  /** Exporter id: 'mp4-h264' | 'mp4-hevc' | 'webm-vp9' | 'mov-prores' | 'png-sequence' | 'gif' | 'wav' ... */
  exporter: string
  options: Record<string, unknown>
  /** Parallel render workers (0 = auto). */
  workers?: number
}

export interface ExportProgress {
  jobId: string
  state: 'preparing' | 'rendering' | 'audio' | 'finalizing' | 'done' | 'error' | 'cancelled'
  framesDone: number
  framesTotal: number
  fps: number
  etaSeconds?: number
  message?: string
  output?: string
}

export interface PluginFile {
  /** Stable id derived from the file name. */
  name: string
  /** Import URL (cache-busted on change). */
  url: string
  path: string
  error?: string
}

export interface McpCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
  thumbnail?: string
}

export interface HostInfo {
  platform: string
  versions: Record<string, string>
  paths: { userData: string; documents: string; home: string; plugins: string; projects: string }
  ffmpeg: { path: string; version: string; hwEncoders: string[] }
  mcp: { url: string; enabled: boolean }
}

export interface HostBridge {
  info(): Promise<HostInfo>
  mediaUrl(path: string): string

  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(fn: (maximized: boolean) => void): () => void
    setTitle(title: string): void
  }

  dialog: {
    openFiles(opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean; directory?: boolean }): Promise<string[]>
    saveFile(opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
    confirm(opts: { message: string; detail?: string; buttons: string[] }): Promise<number>
  }

  fs: {
    readText(path: string): Promise<string>
    writeText(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ size: number; mtime: number } | null>
    /** Filesystem path of a File from a drop / file input (Electron removed `File.path`). */
    pathForFile(file: File): string
  }

  projects: {
    recent(): Promise<RecentProject[]>
    addRecent(p: RecentProject): Promise<void>
    removeRecent(path: string): Promise<void>
  }

  media: {
    probe(path: string): Promise<MediaMeta & { error?: string }>
    thumbnails(path: string, opts?: { height?: number }): Promise<ThumbnailStrip | null>
    waveform(path: string): Promise<WaveformData | null>
    /** Create (or reuse) a Chromium-playable proxy. Resolves to the proxy path. */
    proxy(path: string): Promise<string | null>
    /** Single still frame as a URL (for image thumbnails / posters). */
    poster(path: string, atSeconds?: number): Promise<string | null>
  }

  transcribe: {
    status(): Promise<TranscribeStatus>
    installModel(id: string): Promise<void>
    run(path: string, opts?: TranscribeOptions): Promise<Transcript>
    cancel(): Promise<void>
    onProgress(fn: (progress: TranscribeProgress) => void): () => void
  }

  export: {
    start(req: ExportRequest): Promise<string>
    cancel(jobId: string): Promise<void>
    onProgress(fn: (p: ExportProgress) => void): () => void
    /** Render a single frame to a PNG data URL (used by MCP / thumbnails). */
    frame(req: { project: Project; timelineId: string; time: Flicks; width: number; height: number }): Promise<string>
  }

  plugins: {
    list(): Promise<PluginFile[]>
    onChange(fn: (files: PluginFile[]) => void): () => void
    write(name: string, code: string): Promise<PluginFile>
    remove(name: string): Promise<void>
    openFolder(): void
  }

  mcp: {
    /** Renderer registers the handler that executes MCP tool calls against the live project. */
    onCall(fn: (call: McpCall) => Promise<unknown>): () => void
  }

  settings: {
    load(): Promise<Record<string, unknown>>
    save(values: Record<string, unknown>): Promise<void>
  }

  splash: {
    progress(message: string, done: number, total: number): void
    ready(): void
    /** Splash window only: receive progress from the editor window. */
    onProgress?(fn: (p: { message: string; done: number; total: number }) => void): () => void
  }

  shell: {
    showItemInFolder(path: string): void
    openExternal(url: string): void
  }

  /** Render worker only: talk to the export orchestrator. */
  render?: RenderWorkerBridge
}

export interface RenderWorkerBridge {
  /** Job payload for this worker. */
  job(): Promise<RenderWorkerJob>
  /** Signal that frame `index` is fully painted and may be captured. */
  frameReady(index: number): void
  /** Audio chunk (interleaved Float32 PCM) for the audio pass. */
  audioChunk(index: number, pcm: ArrayBuffer): void
  done(): void
  error(message: string): void
  onCommand(fn: (cmd: { type: 'frame'; index: number; time: Flicks } | { type: 'audio'; index: number; start: number; duration: number }) => void): () => void
}

export interface RenderWorkerJob {
  project: Project
  timelineId: string
  width: number
  height: number
  fps: FrameRate
  mode: 'video' | 'audio' | 'frame'
  /** Height of the frame-stamp strip appended below the frame (cropped by the orchestrator). */
  stampHeight: number
}

declare global {
  interface Window {
    cascade: HostBridge
  }
}
