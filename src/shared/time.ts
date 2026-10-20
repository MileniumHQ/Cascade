/**
 * Time in Cascade is stored as integer "flicks" (1/705,600,000 s).
 * Every common frame rate (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 120, 240)
 * divides it evenly, so timelines can be re-rendered at any frame rate without drift.
 */
export type Flicks = number

export const FLICKS = 705_600_000

export interface FrameRate {
  num: number
  den: number
}

export const fpsValue = (fps: FrameRate): number => fps.num / fps.den

export const secondsToFlicks = (s: number): Flicks => Math.round(s * FLICKS)
export const flicksToSeconds = (t: Flicks): number => t / FLICKS

/** Flicks at the start of frame `n`. */
export const frameToFlicks = (n: number, fps: FrameRate): Flicks => Math.round((n * FLICKS * fps.den) / fps.num)

/** Frame index containing time `t` (floor, robust to rounding). */
export const flicksToFrame = (t: Flicks, fps: FrameRate): number => Math.floor((t * fps.num) / (FLICKS * fps.den) + 1e-6)

/** Snap a time to the nearest frame boundary. */
export const snapToFrame = (t: Flicks, fps: FrameRate): Flicks =>
  frameToFlicks(Math.round((t * fps.num) / (FLICKS * fps.den)), fps)

export const frameDuration = (fps: FrameRate): Flicks => frameToFlicks(1, fps)

export const parseFrameRate = (v: number): FrameRate => {
  // NTSC-style rates
  for (const base of [24, 30, 60, 120]) {
    const ntsc = (base * 1000) / 1001
    if (Math.abs(v - ntsc) < 0.01) return { num: base * 1000, den: 1001 }
  }
  if (Number.isInteger(v)) return { num: v, den: 1 }
  return { num: Math.round(v * 1000), den: 1000 }
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** Digit count used for the frame field: 30fps → 2, 240fps → 3 (like the original Cascade). */
export const frameDigits = (fps: FrameRate) => String(Math.max(1, Math.ceil(fpsValue(fps)) - 1)).length

/**
 * Cascade timecode: `HH:MM:SS.FF`. Seconds are real seconds; FF is the frame within that second.
 */
export function formatTimecode(t: Flicks, fps: FrameRate): string {
  const neg = t < 0
  const abs = Math.abs(t)
  const totalSeconds = Math.floor(abs / FLICKS + 1e-9)
  const rem = abs - totalSeconds * FLICKS
  const frame = Math.min(Math.ceil(fpsValue(fps)) - 1, Math.floor((rem / FLICKS) * fpsValue(fps) + 1e-6))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}.${pad(frame, frameDigits(fps))}`
}

/** Split for display: [main "HH:MM:SS", frames "FF"]. */
export function timecodeParts(t: Flicks, fps: FrameRate): [string, string] {
  const tc = formatTimecode(t, fps)
  const i = tc.lastIndexOf('.')
  return [tc.slice(0, i), tc.slice(i + 1)]
}

/** Parse "HH:MM:SS.FF", "MM:SS", "SS", "SS.FF" or "+12" style frame offsets. */
export function parseTimecode(text: string, fps: FrameRate, relativeTo: Flicks = 0): Flicks | null {
  const s = text.trim()
  if (!s) return null
  if (/^[+-]\d+$/.test(s)) return relativeTo + frameToFlicks(parseInt(s, 10), fps)
  const m = s.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d+))?$/)
  if (!m) return null
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, mi, se] = parts
  const frames = m[4] ? parseInt(m[4], 10) : 0
  return secondsToFlicks(h * 3600 + mi * 60 + se) + Math.round((frames / fpsValue(fps)) * FLICKS)
}

/**
 * Ruler label, shortened as you zoom out (like the original): `:SS`, `MM:SS`, `HH:MM:SS`,
 * with frames appended for sub-second ticks.
 */
export function formatRulerLabel(t: Flicks, fps: FrameRate, stepFlicks: Flicks): string {
  const totalSeconds = Math.floor(t / FLICKS + 1e-9)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  let label = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  if (stepFlicks < FLICKS) {
    const frame = Math.floor(((t - totalSeconds * FLICKS) / FLICKS) * fpsValue(fps) + 1e-6)
    label += `.${pad(frame, frameDigits(fps))}`
  }
  return label
}

/** Pick a "nice" ruler tick step so labels are at least `minPx` apart. */
export function rulerStep(pxPerSecond: number, fps: FrameRate, minPx = 80): { major: Flicks; minor: Flicks } {
  const frame = frameDuration(fps)
  const candidates: Flicks[] = [
    frame, frame * 2, frame * 5, frame * 10,
    FLICKS / 2, FLICKS, FLICKS * 2, FLICKS * 5, FLICKS * 10, FLICKS * 15, FLICKS * 30,
    FLICKS * 60, FLICKS * 120, FLICKS * 300, FLICKS * 600, FLICKS * 900, FLICKS * 1800, FLICKS * 3600
  ]
  const pxPerFlick = pxPerSecond / FLICKS
  for (let i = 0; i < candidates.length; i++) {
    const step = candidates[i]
    if (step * pxPerFlick >= minPx) {
      const secs = step / FLICKS
      const div = secs >= 1 && Number.isInteger(secs) ? (secs % 5 === 0 ? 5 : secs % 3 === 0 ? 3 : 2) : 2
      return { major: step, minor: Math.max(frame, step / div) }
    }
  }
  const last = candidates[candidates.length - 1]
  return { major: last, minor: last / 4 }
}
