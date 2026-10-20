import { FLICKS, type Flicks } from '@shared/time'
import type { MediaItem } from '@shared/project'

/** Compact duration for badges: m:ss, or h:mm:ss past an hour. */
export function formatDuration(t: Flicks): string {
  const total = Math.max(1, Math.round(t / FLICKS))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "1920×1080 · 30 fps" style detail line, using whatever the media knows about itself. */
export function mediaDetail(m: MediaItem, typeName: string): string {
  const { width, height, fps, audioCodec, hasVideo } = m.meta
  const parts: string[] = width && height ? [] : [typeName]
  if (width && height) parts.push(`${width}×${height}`)
  if (fps && hasVideo !== false && width) {
    const v = fps.num / fps.den
    parts.push(`${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '')} fps`)
  }
  if (!width && audioCodec) parts.push(audioCodec.toUpperCase())
  return parts.join(' · ')
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const compareNames = (a: string, b: string) => collator.compare(a, b)

/** Deterministic 0..1 sequence from a string (stable decorative waveforms). */
export function seeded(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Decorative waveform as an SVG data URI (audio has no poster to show). */
export function waveformGlyph(seed: string, color: string): string {
  const rnd = seeded(seed)
  const bars = 36
  let env = 0.5
  let rects = ''
  for (let i = 0; i < bars; i++) {
    env = Math.min(1, Math.max(0.12, env + (rnd() - 0.5) * 0.7))
    const h = Math.max(2, env * 44)
    rects += `<rect x="${i * 4 + 0.5}" y="${(50 - h) / 2}" width="2.4" height="${h}" rx="1.2"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bars * 4} 50" fill="${color}">${rects}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
