import type { ExportRequest, FFmpegExportPlan } from '../../shared/ipc'
import { FLICKS } from '../../shared/time'

/** Integer half-open frame partitions; independently rounding time boundaries loses frames. */
export function partitionFrames(total: number, count: number): { start: number; end: number }[] {
  count = Math.max(1, Math.min(total, Math.floor(count)))
  return Array.from({ length: count }, (_, i) => ({ start: Math.floor(total * i / count), end: Math.floor(total * (i + 1) / count) }))
}

const videoFlags = new Set(['-c:v', '-codec:v', '-crf', '-preset', '-pix_fmt', '-profile:v', '-level', '-level:v', '-tag:v', '-b:v', '-maxrate', '-bufsize', '-qp', '-global_quality', '-quality', '-deadline', '-cpu-used', '-row-mt', '-tile-columns', '-tiles', '-g', '-bf', '-tune', '-compression_level', '-vf', '-x264-params', '-x265-params', '-svtav1-params', '-vtag', '-q:v'])
const audioFlags = new Set(['-c:a', '-codec:a', '-b:a', '-q:a', '-compression_level', '-application', '-vbr', '-cutoff', '-sample_fmt', '-ar', '-ac'])
function validateArgs(args: unknown, flags: Set<string>): asserts args is string[] {
  if (!Array.isArray(args) || args.length > 100 || args.length % 2) throw new Error('Encoding arguments must be option/value pairs')
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.has(args[i]) || typeof args[i + 1] !== 'string' || args[i + 1].length > 2048 || /[\0\r\n]/.test(args[i + 1])) throw new Error(`Invalid encoding option ${String(args[i])}`)
    // Filters may transform frames but cannot open extra files/devices or execute commands.
    if (args[i] === '-vf' && !/^(?:(?:format=[a-z0-9_|]+|hwupload|scale=[0-9:=-]+|fps=[0-9/.]+),?)+$/i.test(args[i + 1])) throw new Error('Unsupported encoding filter')
  }
}
export function validatePlan(plan: FFmpegExportPlan): void {
  if (!plan || typeof plan !== 'object') throw new Error('An exporter encoding plan is required')
  validateArgs(plan.videoArgs, videoFlags)
  validateArgs(plan.audioArgs, audioFlags)
  if (!/^[a-z0-9]{1,16}$/i.test(plan.extension)) throw new Error('Invalid output extension')
  for (const format of [plan.container, plan.segmentContainer]) if (format !== undefined && !/^[a-z0-9_]{1,32}$/i.test(format)) throw new Error('Invalid container')
  if (plan.kind !== undefined && !['video', 'audio', 'sequence'].includes(plan.kind)) throw new Error('Invalid export kind')
  if (plan.twoPass !== undefined && plan.twoPass !== 'palette') throw new Error('Unsupported two-pass plan')
  if (plan.inputArgs) validateArgs(plan.inputArgs, new Set(['-vaapi_device']))
  if (plan.fallback) {
    validateArgs(plan.fallback.videoArgs, videoFlags)
    if (plan.fallback.inputArgs) validateArgs(plan.fallback.inputArgs, new Set(['-vaapi_device']))
  }
}
export function validateRequest(req: ExportRequest): number {
  if (!req || !req.project?.timelines?.[req.timelineId]) throw new Error('Unknown timeline')
  for (const value of [req.width, req.height]) if (!Number.isSafeInteger(value) || value < 1 || value > 16384) throw new Error('Export dimensions must be integers between 1 and 16384')
  if (!Number.isSafeInteger(req.fps?.num) || !Number.isSafeInteger(req.fps?.den) || req.fps.num <= 0 || req.fps.den <= 0 || req.fps.num / req.fps.den > 240) throw new Error('Invalid frame rate')
  if (!Number.isSafeInteger(req.range?.start) || !Number.isSafeInteger(req.range?.end) || req.range.start < 0 || req.range.end <= req.range.start) throw new Error('Invalid export range')
  if (typeof req.output !== 'string' || !req.output || /[\0\r\n]/.test(req.output)) throw new Error('Invalid output path')
  if (req.workers !== undefined && (!Number.isSafeInteger(req.workers) || req.workers < 0 || req.workers > 32)) throw new Error('Workers must be between 0 and 32')
  if (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000].includes(req.project.settings.sampleRate)) throw new Error('Unsupported project sample rate')
  validatePlan(req.encoding)
  const frames = Math.ceil((req.range.end - req.range.start) * req.fps.num / (FLICKS * req.fps.den) - 1e-8)
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 0x7fffffff) throw new Error('Invalid frame count')
  return frames
}

/** Read directly from Electron's native BGRA bitmap, without crop/copy/base64 work. */
export function readStamp(bitmap: Buffer, width: number, height: number, stampHeight: number): number | null {
  const stride = width * 4
  if (bitmap.length < stride * (height + stampHeight)) return null
  const columns = Math.min(8, width), rows = Math.ceil(8 / columns)
  if (stampHeight < rows) return null
  let value = 0
  for (let i = 0; i < 8; i++) {
    const col = i % columns, row = Math.floor(i / columns)
    const x = Math.floor((Math.floor(col * width / columns) + Math.floor((col + 1) * width / columns) - 1) / 2)
    const y = Math.floor((Math.floor(row * stampHeight / rows) + Math.floor((row + 1) * stampHeight / rows)) / 2)
    const at = (height + y) * stride + x * 4
    const green = bitmap[at + 1]
    const nibble = Math.round((green - 8) / 16)
    if (nibble < 0 || nibble > 15 || Math.abs(green - (nibble * 16 + 8)) > 1 || Math.abs(bitmap[at + 2] + green - 255) > 1 || Math.abs(bitmap[at] - 117) > 1) return null
    value = (value | nibble << (i * 4)) >>> 0
  }
  return value
}
