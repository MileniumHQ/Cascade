import { constantMap, type TimeMap } from '@core/time-remap'
import type { Transcript, TranscriptWord } from '@shared/ipc'
import { FLICKS } from '@shared/time'

export interface CaptionLine { text: string; start: number; end: number }
const MIN = Math.round(0.7 * FLICKS)
const PAUSE = Math.round(0.45 * FLICKS)
const MAX = 6 * FLICKS

/** At most two lines, balanced at word boundaries; long single words stay intact. */
function wrap(words: TranscriptWord[]): string | null {
  const texts = words.map((w) => w.text)
  const text = texts.join(' ')
  if (text.length <= 42) return text
  let best: string | null = null
  let score = Infinity
  for (let i = 1; i < texts.length; i++) {
    const a = texts.slice(0, i).join(' '), b = texts.slice(i).join(' ')
    if (a.length <= 42 && b.length <= 42 && Math.abs(a.length - b.length) < score) {
      best = `${a}\n${b}`; score = Math.abs(a.length - b.length)
    }
  }
  return best
}

/** Map before grouping, so pauses/minimum reading time respect playback speed. */
export function groupCaptions(transcript: Transcript, mapping: { sourceIn: number; start: number; speed: number | TimeMap; end: number }): CaptionLine[] {
  const { sourceIn, start, speed, end } = mapping
  if (typeof speed === 'number' && (!Number.isFinite(speed) || speed <= 0)) throw new Error('Captions require a positive playback speed')
  const remap = typeof speed === 'number' ? constantMap(speed) : speed
  const map = (t: number) => Math.round(start + remap.localAt(t - sourceIn))
  const words = transcript.segments.flatMap((s) => s.words).map((w) => ({ ...w, start: Math.max(start, map(w.start)), end: Math.min(end, map(w.end)) }))
    .filter((w) => w.text.trim() && w.end > start && w.start < end).sort((a, b) => a.start - b.start)
  const groups: TranscriptWord[][] = []
  let pending: TranscriptWord[] = []
  const flush = () => { if (pending.length) groups.push(pending); pending = [] }
  for (const word of words) {
    if (pending.length) {
      const last = pending.at(-1)!
      if (!wrap([...pending, word]) || word.start - pending[0].start >= MAX || word.start - last.end > PAUSE ||
        (/[.!?]["'’”]?$/.test(last.text) && word.start - pending[0].start >= MIN)) flush()
    }
    pending.push(word)
  }
  flush()
  // Avoid a brief trailing word when the character limit splits a sentence.
  // Borrow words from its preceding caption before considering a merge.
  for (let i = 0; i < groups.length; i++) {
    const available = () => Math.min(groups[i + 1]?.[0].start ?? end, end) - groups[i][0].start
    const previous = groups[i - 1]
    if (previous && groups[i][0].start - previous.at(-1)!.end <= PAUSE) {
      while (available() < MIN && previous.length > 1) {
        const word = previous.at(-1)!
        if (word.start - previous[0].start < MIN || !wrap([word, ...groups[i]])) break
        groups[i].unshift(previous.pop()!)
      }
      if (available() < MIN && wrap([...previous, ...groups[i]])) {
        previous.push(...groups[i]); groups.splice(i, 1); i--; continue
      }
    }
    if (available() < MIN && groups[i + 1] && groups[i + 1][0].start - groups[i].at(-1)!.end <= PAUSE && wrap([...groups[i], ...groups[i + 1]])) {
      groups[i].push(...groups[i + 1]); groups.splice(i + 1, 1); i--
    }
  }
  const captions = groups.map((g) => ({ text: wrap(g) ?? g.map((w) => w.text).join(' '), start: g[0].start, end: g.at(-1)!.end }))
  // Extend short phrases only into free space; a dense phrase may need to remain shorter.
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i]
    const next = captions[i + 1]?.start ?? end
    c.end = Math.min(next, end, Math.max(c.end, c.start + MIN))
    if (i > 0) c.start = Math.max(c.start, captions[i - 1].end)
  }
  return captions.filter((c) => c.end > c.start)
}
