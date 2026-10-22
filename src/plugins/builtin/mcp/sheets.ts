import type { CascadeAPI } from '@core/app'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { FLICKS, type Flicks } from '@shared/time'
import { clock } from './clock'
import { frame } from './images'
import { LoudnessMeter } from './loudness'

/** One cell: the frame at `t`, standing for [t, end). */
export interface Cell { t: Flicks; end: Flicks; label?: string }
/** Mixed or source audio covering the sheet, `start` = time of sample 0. */
export interface SheetAudio { data: Float32Array; rate: number; start: Flicks }
export interface CellData {
  cell: number; page: number; time: string; t: Flicks; until: string
  luma: number; change: number; loudness?: number; flags: string[]; [extra: string]: unknown
}

const PER_PAGE = 30
const LONG_EDGE = 1568

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not load frame')); img.src = url })
}

/** Mean luma (0–1) and color of a tiny copy, plus that copy for frame-to-frame change. */
export function stats(img: HTMLImageElement): { luma: number; color: string; pixels: Uint8ClampedArray } {
  const c = document.createElement('canvas'); c.width = 32; c.height = 18
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, 32, 18)
  const pixels = ctx.getImageData(0, 0, 32, 18).data
  let sum = 0
  const rgb = [0, 0, 0], n = pixels.length / 4
  for (let i = 0; i < pixels.length; i += 4) { sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]; rgb[0] += pixels[i]; rgb[1] += pixels[i + 1]; rgb[2] += pixels[i + 2] }
  return { luma: sum / n / 255, color: `#${rgb.map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('')}`, pixels }
}
export const change = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
  return sum / (a.length / 4 * 3 * 255)
}

/** Min/max waveform of [from, to) seconds into the audio, drawn in a box. */
function drawWave(ctx: CanvasRenderingContext2D, audio: SheetAudio, from: number, to: number, x: number, y: number, w: number, h: number) {
  const frames = audio.data.length / 2
  ctx.fillStyle = '#1b1b1f'; ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#82cbff'; ctx.beginPath()
  for (let px = 0; px < w; px++) {
    const i0 = Math.max(0, Math.floor((from + (to - from) * px / w) * audio.rate)), i1 = Math.min(frames, Math.ceil((from + (to - from) * (px + 1) / w) * audio.rate))
    let lo = 0, hi = 0
    for (let i = i0; i < i1; i++) { const v = (audio.data[i * 2] + audio.data[i * 2 + 1]) / 2; if (v < lo) lo = v; if (v > hi) hi = v }
    ctx.moveTo(x + px + 0.5, y + h / 2 - hi * h / 2); ctx.lineTo(x + px + 0.5, y + h / 2 - lo * h / 2 + 0.5)
  }
  ctx.stroke()
}

export interface SheetOptions {
  cells: Cell[]
  columns?: number
  labels: boolean
  flags: boolean
  format: 'sheet' | 'json' | 'both'
  /** Source to sample instead of the timeline. */
  source?: { path: string; width?: number; height?: number }
  audio?: SheetAudio
  /** Timeline context per cell (clips, words…) and extra flags such as text-overflow. */
  describe?: (t: Flicks) => { note?: string; data?: Record<string, unknown>; flags?: string[] }
  footer?: string
}

/** Render cells as labeled JPEG pages (≤30 cells each) and measure each cell: luma, change from the previous cell, loudness. */
export async function renderSheets(app: CascadeAPI, o: SheetOptions): Promise<CallToolResult> {
  const project = app.project()
  const count = o.cells.length
  if (!count) throw new Error('No cells in this range')
  const columns = Math.min(count, o.columns ?? (count <= 9 ? 3 : 6))
  const ratio = o.source ? (o.source.width ?? 16) / (o.source.height ?? 9) : project.settings.width / project.settings.height
  const cellW = Math.floor(Math.min(480, LONG_EDGE / columns)), cellH = Math.round(cellW / ratio)
  const labelH = o.labels ? Math.max(16, Math.round(cellW / 16)) : 0, waveH = o.audio ? Math.max(14, Math.round(cellH / 5)) : 0
  const meter = o.audio && new LoudnessMeter(o.audio.data, o.audio.rate)
  const at = (t: Flicks) => o.audio ? (t - o.audio.start) / FLICKS : 0
  const images: string[] = [], data: CellData[] = [], lines: string[] = []
  let previous: Uint8ClampedArray | undefined
  for (let page = 0; page * PER_PAGE < count; page++) {
    const cells = o.cells.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
    const rows = Math.ceil(cells.length / columns), rowH = cellH + labelH + waveH
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(cells.length, columns) * cellW; canvas.height = rows * rowH
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#111113'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (const [j, cell] of cells.entries()) {
      const i = page * PER_PAGE + j
      const url = o.source ? await app.host!.media.poster(o.source.path, cell.t / FLICKS) : await frame(app, cell.t, cellW, project)
      if (!url) throw new Error(`No frame at ${clock(cell.t)}; the source may be audio-only`)
      const img = await loadImage(url)
      const x = j % columns * cellW, y = Math.floor(j / columns) * rowH
      ctx.drawImage(img, x, y, cellW, cellH)
      const { luma, pixels } = stats(img)
      const diff = previous ? change(previous, pixels) : 1
      previous = pixels
      const described = o.describe?.(cell.t) ?? {}
      const flags: string[] = []
      let loudness: number | undefined
      if (meter) {
        const r = meter.measure(Math.max(0, at(cell.t)), Math.max(at(cell.t) + 0.05, at(cell.end)))
        loudness = Number.isFinite(r.momentaryMax) ? Math.round(r.momentaryMax * 10) / 10 : -Infinity
        drawWave(ctx, o.audio!, at(cell.t), at(cell.end), x, y + cellH + labelH, cellW, waveH)
        if (o.flags && r.momentaryMax < -50) flags.push('silence')
      }
      if (o.flags) {
        if (luma < 0.03) flags.push('black')
        else if (i > 0 && diff < 0.004) flags.push('static')
        flags.push(...described.flags ?? [])
      }
      const label = `${i + 1}  ${cell.label ?? clock(cell.t)}${flags.length ? `  ⚑ ${flags.join(',')}` : ''}`
      if (o.labels) {
        ctx.fillStyle = flags.length ? '#ffb4a8' : '#e8e8ea'; ctx.font = `${Math.round(labelH * 0.68)}px Inter, sans-serif`
        ctx.fillText(label, x + 6, y + cellH + labelH * 0.74, cellW - 12)
      }
      data.push({ cell: i + 1, page: page + 1, time: clock(cell.t), t: cell.t, until: clock(cell.end), luma: Math.round(luma * 1000) / 1000, change: Math.round(diff * 1000) / 1000, ...(loudness !== undefined ? { loudness } : {}), flags, ...described.data })
      lines.push(`${i + 1}: ${cell.label?.startsWith(clock(cell.t)) ? cell.label : `${clock(cell.t)}${cell.label ? ` ${cell.label}` : ''}`} (${cell.t})${described.note ? ` ${described.note}` : ''}${loudness !== undefined ? `; ${Number.isFinite(loudness) ? `${loudness} LUFS` : 'silent'}` : ''}${flags.length ? ` ⚑ ${flags.join(', ')}` : ''}`)
    }
    if (o.format !== 'json') images.push(canvas.toDataURL('image/jpeg', 0.8))
  }
  const head = `${count} cells${images.length > 1 ? ` on ${images.length} images (${PER_PAGE} per image)` : ''}, left to right, top to bottom${o.audio ? '; waveform under each cell, loudness = loudest 400 ms' : ''}`
  const content: CallToolResult['content'] = []
  if (o.format === 'json') content.push({ type: 'text', text: JSON.stringify({ cells: data, ...(o.footer ? { note: o.footer } : {}) }) })
  else {
    content.push({ type: 'text', text: [head, ...(o.format === 'sheet' ? lines : []), ...(o.footer ? [o.footer] : [])].join('\n') })
    for (const url of images) content.push({ type: 'image', mimeType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) })
    if (o.format === 'both') content.push({ type: 'text', text: JSON.stringify({ cells: data }) })
  }
  return { content }
}
