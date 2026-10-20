import type { Project } from '@shared/project'
import type { CascadeAPI } from '@core/app'
import { formatTimecode, frameDuration, FLICKS } from '@shared/time'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export async function frame(app: CascadeAPI, time: number, width: number, p: Project = app.project()): Promise<string> {
  const requestedHeight = width * p.settings.height / p.settings.width
  const scale = Math.min(1, 1568 / Math.max(width, requestedHeight))
  width = Math.max(1, Math.round(width * scale))
  const height = Math.max(1, Math.round(requestedHeight * scale))
  try { return await app.host!.export.frame({ project: p, timelineId: p.activeTimeline, time, width, height }) }
  catch (e) { throw new Error(`Frame rendering unavailable: ${String(e)}. Retry after the frame export service is available; use media_contact_sheet to inspect raw media meanwhile.`) }
}
export function imageResult(url: string, label: string): CallToolResult {
  const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(url)
  if (!match) throw new Error('Frame service returned an unsupported image; expected a PNG/JPEG data URL')
  return { content: [{ type: 'text', text: label }, { type: 'image', mimeType: match[1], data: match[2] }] }
}
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not load source frame')); img.src = url })
}
export async function sheet(app: CascadeAPI, args: { start?: number; end?: number; count?: number; interval?: number; columns?: number }, source?: { path: string; duration: number; width?: number; height?: number }): Promise<CallToolResult> {
  if (args.count !== undefined && args.interval !== undefined) throw new Error('Choose count OR interval')
  const project = app.project()
  const fps = project.settings.fps
  const start = args.start ?? 0
  const end = args.end ?? (source?.duration ?? app.duration())
  if (end <= start) throw new Error('Sheet range must have positive duration; add clips or specify start/end')
  if (source && end > source.duration) throw new Error('Sheet range exceeds source duration')
  const count = args.interval ? Math.ceil((end - start) / args.interval) : args.count ?? 9
  if (count < 1 || count > 24) throw new Error('Sheet needs 1–24 cells. Increase interval or use count.')
  const columns = Math.min(args.columns ?? 3, count)
  const rows = Math.ceil(count / columns)
  const ratio = source ? (source.width ?? 16) / (source.height ?? 9) : project.settings.width / project.settings.height
  const cellW = 480, cellH = Math.round(cellW / ratio), labelH = 30
  const scale = Math.min(1, 1568 / Math.max(columns * cellW, rows * (cellH + labelH)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(columns * cellW * scale)); canvas.height = Math.max(1, Math.floor(rows * (cellH + labelH) * scale))
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale); ctx.fillStyle = '#111113'; ctx.fillRect(0, 0, columns * cellW, rows * (cellH + labelH))
  const mapping: string[] = []
  for (let i = 0; i < count; i++) {
    const t = Math.round(start + (args.interval ? i * args.interval : count === 1 ? 0 : i * Math.max(0, end - start - frameDuration(fps)) / (count - 1)))
    const url = source ? await app.host!.media.poster(source.path, t / FLICKS) : await frame(app, t, 480, project)
    if (!url) throw new Error(`No frame at ${t}; source might be audio-only`)
    const img = await loadImage(url)
    const x = i % columns * cellW, y = Math.floor(i / columns) * (cellH + labelH)
    ctx.drawImage(img, x, y, cellW, cellH)
    const label = `${i + 1}: ${formatTimecode(t, fps)}`
    ctx.fillStyle = '#eeeeee'; ctx.font = '18px sans-serif'; ctx.fillText(label, x + 8, y + cellH + 21)
    mapping.push(`${label} (${t} flicks)`)
  }
  return imageResult(canvas.toDataURL('image/jpeg', 0.8), `${canvas.width}×${canvas.height} JPEG; cells left to right, top to bottom\n${mapping.join('\n')}`)
}
