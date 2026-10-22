/**
 * Word timing with Qwen3-ForcedAligner (native/cascade-align): whisper supplies the words, the aligner
 * places each word's start and end on an 80 ms grid. Pure planning and mapping; transcribe.ts runs it.
 */
import type { Transcript, TranscriptWord } from '../shared/ipc'
import { FLICKS } from '../shared/time'

/** The aligner's units for one word, as the upstream processor tokenizes: letters, digits and
 * apostrophes are kept (so "co-op." → "coop"), and each CJK ideograph is its own unit. */
export function alignUnits(text: string): string[] {
  const units: string[] = []
  let run = ''
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0)!)) {
      if (run) units.push(run)
      run = ''
      units.push(ch)
    } else if (ch === "'" || /[\p{L}\p{N}]/u.test(ch)) run += ch
  }
  if (run) units.push(run)
  return units
}

function isCjk(code: number) {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) || (code >= 0x2b740 && code <= 0x2b81f) || (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff)
}

export interface AlignChunk {
  /** Audio range in the extracted wav, milliseconds. */
  start: number
  end: number
  /** Transcript word indices, in order, each with its unit count. */
  words: number[]
  counts: number[]
  units: string[]
}

/** Chunks are cut at the widest pause after `minMs` of speech (snapped into an acoustic silence when
 * one overlaps it), stay under `maxMs`, and carry at most `padMs` of audio beyond their outer words. */
export function planAlignment(words: { text: string; start: number; end: number }[], durationMs: number,
  silences: { start: number; end: number }[] = [], { minMs = 30_000, maxMs = 90_000, padMs = 1_000 } = {}): AlignChunk[] {
  const items = words.map((w, i) => ({ i, units: alignUnits(w.text), start: w.start, end: w.end })).filter((w) => w.units.length)
  const cut = (a: { end: number }, b: { start: number }) => {
    let best: { start: number; end: number } | undefined
    for (const s of silences) {
      const start = Math.max(s.start, a.end), end = Math.min(s.end, b.start)
      if (end > start && (!best || end - start > best.end - best.start)) best = { start, end }
    }
    return best ? (best.start + best.end) / 2 : (a.end + b.start) / 2
  }
  const chunks: AlignChunk[] = []
  let previousCut = 0
  for (let i = 0; i < items.length;) {
    const first = items[i].start
    let j = i
    while (j + 1 < items.length && items[j + 1].end - first <= maxMs) j++
    if (j + 1 < items.length) {
      let best = -1, bestGap = -Infinity
      for (const late of [true, false]) {
        for (let k = i; k <= j; k++) {
          if (late && items[k].end - first < minMs) continue
          const gap = items[k + 1].start - items[k].end
          if (gap > bestGap) { best = k; bestGap = gap }
        }
        if (best >= 0) break
      }
      j = best
    }
    const nextCut = j + 1 < items.length ? cut(items[j], items[j + 1]) : durationMs
    const part = items.slice(i, j + 1)
    chunks.push({
      start: Math.max(0, previousCut, part[0].start - padMs),
      end: Math.min(durationMs, nextCut, part.at(-1)!.end + padMs),
      words: part.map((w) => w.i), counts: part.map((w) => w.units.length), units: part.flatMap((w) => w.units)
    })
    previousCut = nextCut
    i = j + 1
  }
  return chunks
}

export type AlignResult = { start: number[]; end: number[] } | { error: string }

/** Replace word times with aligned ones (ms in the wav, `offset` = the wav's source time). A chunk
 * whose result is missing, malformed or out of range keeps its existing timing. Returns the number
 * of words aligned. */
export function applyAlignment(transcript: Transcript, chunks: AlignChunk[], results: AlignResult[], offset: number): number {
  const words = transcript.segments.flatMap((s) => s.words)
  const at = (ms: number) => offset + Math.round(ms) * (FLICKS / 1000)
  const aligned = new Set<TranscriptWord>()
  chunks.forEach((chunk, c) => {
    const result = results[c]
    if (!result || 'error' in result || result.start.length !== chunk.units.length || result.end.length !== chunk.units.length) return
    let previous = chunk.start
    for (let u = 0; u < chunk.units.length; u++) {
      const start = result.start[u], end = result.end[u]
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || end < start || start < chunk.start - 80 || end > chunk.end + 80) return
      previous = start
    }
    let u = 0
    const times = chunk.words.map((_, k) => {
      const first = u
      u += chunk.counts[k]
      return { start: result.start[first], end: result.end[u - 1] }
    })
    times.forEach((t, k) => {
      const word = words[chunk.words[k]]
      // Start and end in the same 80 ms class: the word sits inside that frame.
      const next = times[k + 1]?.start ?? chunk.end
      word.start = at(t.start)
      word.end = at(t.end > t.start ? t.end : Math.max(t.start, Math.min(t.start + 80, next)))
      aligned.add(word)
    })
  })
  // Unit-less words (stray punctuation) and seams with unaligned neighbours stay ordered.
  for (let i = 0; i < words.length; i++) {
    const word = words[i], previous = words[i - 1]
    if (!previous) continue
    if (!aligned.has(word) && !alignUnits(word.text).length) word.start = word.end = previous.end
    if (word.start < previous.start) word.start = previous.start
    if (previous.end > word.start) previous.end = Math.max(previous.start, word.start)
    if (word.end < word.start) word.end = word.start
  }
  for (const segment of transcript.segments) {
    if (!segment.words.length) continue
    segment.start = segment.words[0].start
    segment.end = segment.words.at(-1)!.end
  }
  return aligned.size
}
