import type { Project } from '@shared/project'
import type { CascadeAPI } from '@core/app'
import { frameDuration, FLICKS } from '@shared/time'
import { clock } from './clock'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export async function frame(app: CascadeAPI, time: number, width: number, p: Project = app.project()): Promise<string> {
  const requestedHeight = width * p.settings.height / p.settings.width
  const scale = Math.min(1, 1568 / Math.max(width, requestedHeight))
  width = Math.max(1, Math.round(width * scale))
  const height = Math.max(1, Math.round(requestedHeight * scale))
  try { return await app.host!.export.frame({ project: p, timelineId: p.activeTimeline, time, width, height }) }
  catch (e) { throw new Error(`Frame rendering unavailable: ${String(e)}. Retry after the frame export service is available; contact_sheet with mediaId shows source frames meanwhile.`) }
}
export function imageResult(url: string, label: string): CallToolResult {
  const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(url)
  if (!match) throw new Error('Frame service returned an unsupported image; expected a PNG/JPEG data URL')
  return { content: [{ type: 'text', text: label }, { type: 'image', mimeType: match[1], data: match[2] }] }
}
/** One JPEG with each font family rendered in its own face, one row per family. */
export async function fontSpecimen(families: string[], sample: string, weight: number): Promise<string> {
  const rowH = 64, width = 1400
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = families.length * rowH + 8
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#111113'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  const face = (f: string, px: number) => `${weight} ${px}px "${f.replace(/"/g, '')}", sans-serif`
  // System fonts render once requested; give the loader a moment for bundled web fonts.
  await Promise.all(families.map(f => document.fonts.load(face(f, 34), sample).catch(() => [])))
  families.forEach((f, i) => {
    const y = i * rowH
    ctx.fillStyle = '#8a8a90'; ctx.font = '14px Inter, sans-serif'; ctx.fillText(`${i + 1}. ${f}`, 12, y + 20)
    ctx.fillStyle = '#f2f2f2'; ctx.font = face(f, 34); ctx.fillText(sample, 12, y + 56, width - 24)
  })
  return canvas.toDataURL('image/jpeg', 0.85)
}
