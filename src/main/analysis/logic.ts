import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { ANALYSIS_VERSION, type AnalysisEvent, type AnalysisPart, type AnalysisSentence, type AnalysisWord, type SourceAnalysis } from '../../shared/analysis'
import { FLICKS } from '../../shared/time'

export const isFiller = (text: string) => /^(um+|uh+|erm|er|hmm+|mm+|ah)$/i.test(text.replace(/[^\p{L}]/gu, ''))
export function sentences(words: AnalysisWord[]): AnalysisSentence[] {
  const result: AnalysisSentence[] = []
  let first = 0
  const flush = (end: number) => {
    if (end <= first) return
    const start = words[first].start, finish = words[end - 1].end
    result.push({ start, end: finish, words: [first, end], text: words.slice(first, end).map(w => w.text).join(' '), rate: (end - first) / Math.max(0.01, (finish - start) / FLICKS) })
    first = end
  }
  words.forEach((word, i) => {
    if (i > first && (word.start - words[i - 1].end > .6 * FLICKS || word.end - words[first].start > 25 * FLICKS || i - first >= 40)) flush(i)
    if (/[.!?]["'’”]?$/.test(word.text)) flush(i + 1)
  })
  flush(words.length)
  return result
}
export function applyLoudness(words: AnalysisWord[], energy: { sum: number; count: number }[]): number | undefined {
  const levels = energy.map(e => e.count && e.sum > 0 ? 10 * Math.log10(e.sum / e.count) : undefined)
  const speech = levels.filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b)
  if (!speech.length) return undefined
  const middle = Math.floor(speech.length / 2)
  const median = speech.length % 2 ? speech[middle] : (speech[middle - 1] + speech[middle]) / 2
  words.forEach((w, i) => { if (levels[i] !== undefined) w.db = Math.round((levels[i]! - median) * 10) / 10 })
  return median
}

const rules: [RegExp, string, number][] = [
  [/^(Music|Musical instrument|Background music)$/, 'MUSIC', .4],
  [/^(Applause|Clapping)$/, 'APPLAUSE', .35], [/^(Laughter|Chuckle, chortle|Giggle|Belly laugh)$/, 'LAUGHTER', .4],
  [/^(Cheering|Whoop)$/, 'CHEERING', .45], [/^(Crowd|Babble)$/, 'CROWD', .5],
  [/^(Walk, footsteps|Run)$/, 'FOOTSTEPS', .5], [/^(Door|Doorbell|Knock|Slam)$/, 'DOOR', .55],
  [/^(Telephone|Telephone bell ringing|Ringtone)$/, 'PHONE', .5], [/^(Dog|Bark|Bow-wow|Growling)$/, 'DOG', .5],
  [/^(Cough|Throat clearing)$/, 'COUGH', .5], [/^Sigh$/, 'SIGH', .6],
  [/^(Gunshot, gunfire|Machine gun)$/, 'GUNSHOT', .6], [/^(Explosion|Boom)$/, 'EXPLOSION', .6],
  [/^Siren$/, 'SIREN', .5], [/^(Crying, sobbing|Baby cry, infant cry)$/, 'CRYING', .5],
  [/^(Alarm|Smoke detector, smoke alarm|Fire alarm)$/, 'ALARM', .55],
  [/^(Glass|Shatter)$/, 'GLASS', .6], [/^(Rain|Thunder|Wind)$/, 'WEATHER', .6],
  [/^(Car|Engine|Vehicle)$/, 'VEHICLE', .65], [/^Sneeze$/, 'SNEEZE', .55]
]
export function labelCue(label: string) {
  const rule = rules.find(([pattern]) => pattern.test(label))
  return rule ? { cue: rule[1], threshold: rule[2] } : undefined
}
export interface TagWindow { start: number; end: number; tags: { name: string; prob: number }[] }
/** One frame per hop. Enter at the class threshold, leave below 60%; merge gaps ≤ one hop. */
export class EventMerger {
  private active = new Map<string, AnalysisEvent>()
  readonly events: AnalysisEvent[] = []
  push(window: TagWindow) {
    const candidates = new Map<string, { name: string; prob: number; threshold: number }>()
    for (const tag of window.tags) {
      const rule = labelCue(tag.name)
      if (rule && (!candidates.has(rule.cue) || candidates.get(rule.cue)!.prob < tag.prob)) candidates.set(rule.cue, { ...tag, threshold: rule.threshold })
    }
    for (const [cue, event] of this.active) {
      const candidate = candidates.get(cue)
      if (!candidate || candidate.prob < candidate.threshold * .6 || window.start > event.end + FLICKS) {
        this.events.push(event); this.active.delete(cue)
      }
    }
    for (const [cue, candidate] of candidates) {
      const event = this.active.get(cue)
      if (event) { event.end = window.end; event.score = Math.max(event.score, candidate.prob) }
      else if (candidate.prob >= candidate.threshold) this.active.set(cue, { cue, label: candidate.name, score: candidate.prob, start: window.start, end: window.end })
    }
  }
  finish(words: AnalysisWord[]) {
    this.events.push(...this.active.values()); this.active.clear()
    // Union word intervals so uncertain/overlapping word bounds cannot double-count speech.
    const speech: { start: number; end: number }[] = []
    for (const word of words) {
      const previous = speech.at(-1)
      if (previous && word.start <= previous.end) previous.end = Math.max(previous.end, word.end)
      else speech.push({ start: word.start, end: word.end })
    }
    const merged: AnalysisEvent[] = [], previous = new Map<string, AnalysisEvent>()
    for (const event of this.events.sort((a, b) => a.start - b.start)) {
      const last = previous.get(event.cue)
      if (last && event.start - last.end <= FLICKS) {
        last.end = Math.max(last.end, event.end)
        if (event.score > last.score) { last.score = event.score; last.label = event.label }
      } else { const copy = { ...event }; merged.push(copy); previous.set(event.cue, copy) }
    }
    return merged.map(event => ({ ...event,
      underSpeech: speech.reduce((sum, word) => sum + Math.max(0, Math.min(event.end, word.end) - Math.max(event.start, word.start)), 0) > (event.end - event.start) / 2 }))
  }
}
export function cacheKey(path: string, info: { mtimeMs: number; size: number }, range: SourceAnalysis['range'], language: string, parts: AnalysisPart[]) {
  return createHash('sha256').update(JSON.stringify([ANALYSIS_VERSION, resolve(path), info.mtimeMs, info.size, range, language, [...new Set(parts)].sort()])).digest('hex')
}
/** Commit each part only after it succeeds. A failed optional part never erases earlier work. */
export async function completePart(result: SourceAnalysis, part: AnalysisPart, work: () => Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted()
  const start = performance.now()
  try { await work(); signal.throwIfAborted(); result.parts.push(part) }
  catch (error) { signal.throwIfAborted(); (result.errors ??= {})[part] = error instanceof Error ? error.message : String(error) }
  finally { (result.timings ??= {})[part] = Math.round(performance.now() - start) }
}

/** Pitch frames are 10 ms apart; a 16 kHz frame index is `hop * PITCH_HOP_SAMPLES`. */
export const PITCH_HOP_SAMPLES = 160
/**
 * YIN pitch (60–400 Hz) on 16 kHz mono, computed at 8 kHz. One f0 per 10 ms hop, 0 = unvoiced.
 * Only frames inside `spans` (half-open hop ranges) are analysed; the rest stay 0.
 */
export function pitchTrack(samples: Float32Array, spans: [number, number][] = [[0, Infinity]]): Float32Array {
  const n = samples.length >> 1, x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = (samples[2 * i] + samples[2 * i + 1]) / 2
  const W = 320, MIN = 20, MAX = 134, hops = Math.floor(samples.length / PITCH_HOP_SAMPLES)
  const f0 = new Float32Array(hops), d = new Float32Array(MAX + 2)
  for (const [from, to] of spans) {
    for (let h = Math.max(0, from); h < Math.min(hops, to); h++) {
      const o = h * (PITCH_HOP_SAMPLES >> 1) - (W >> 1)
      if (o < 0 || o + W + MAX + 1 > n) continue
      let energy = 0
      for (let j = 0; j < W; j++) energy += x[o + j] * x[o + j]
      if (energy / W < 1e-6) continue // ≈ -60 dBFS: too quiet to be voiced speech.
      let sum = 0
      for (let tau = 1; tau <= MAX + 1; tau++) {
        let s = 0
        for (let j = 0; j < W; j++) { const v = x[o + j] - x[o + j + tau]; s += v * v }
        sum += s; d[tau] = sum ? s * tau / sum : 1 // Cumulative mean normalised difference.
      }
      let tau = MIN
      while (tau <= MAX && d[tau] >= 0.15) tau++
      if (tau > MAX) continue
      while (tau < MAX && d[tau + 1] < d[tau]) tau++
      const a = d[tau - 1], b = d[tau], c = d[tau + 1], shift = (a - 2 * b + c) ? (a - c) / (2 * (a - 2 * b + c)) : 0
      f0[h] = 8000 / (tau + Math.max(-1, Math.min(1, shift)))
    }
  }
  return f0
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const round1 = (v: number) => Math.round(v * 10) / 10
/** Least-squares line through (x, y); falls back to the mean for a single x. */
function trend(xs: number[], ys: number[]) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2 })
  const k = sxx ? sxy / sxx : 0
  return (x: number) => my + k * (x - mx)
}
/**
 * Measured prosody. `f0[i]` holds word i's voiced pitch frames (Hz) in time order.
 * - `word.st`: semitones vs the median pitch of the surrounding ±10 sentences (adapts to speaker changes).
 * - `word.emphasis`: pitch and loudness both rise above the sentence's own downward trend (declination),
 *   the word has ≥ 80 ms of voicing and is not rushed. At most one per sentence; conservative by design.
 * - `sentence.pitch`: 10th–90th percentile spread and the direction of the last voiced word.
 * Returns the source's median speaking pitch (Hz).
 */
export function applyProsody(words: AnalysisWord[], list: AnalysisSentence[], f0: number[][]): number | undefined {
  const all = f0.flat()
  if (all.length < 10) return undefined
  const frames = list.map(s => f0.slice(s.words[0], s.words[1]).flat())
  list.forEach((sentence, n) => {
    const near = frames.slice(Math.max(0, n - 10), n + 11).flat()
    if (near.length < 10) return
    const base = median(near), st = (hz: number) => 12 * Math.log2(hz / base)
    const [from, to] = sentence.words
    for (let i = from; i < to; i++) if (f0[i].length >= 3) words[i].st = round1(st(median(f0[i])))
    const spread = frames[n].map(st).sort((a, b) => a - b)
    if (spread.length < 10) return
    const last = f0.slice(from, to).findLast(f => f.length >= 4)
    let end: 'rise' | 'fall' | 'level' = 'level'
    if (last) {
      const k = Math.max(2, Math.floor(last.length * 0.4))
      const slope = st(median(last.slice(-k))) - st(median(last.slice(0, k)))
      end = slope >= 2 ? 'rise' : slope <= -2 ? 'fall' : 'level'
    }
    sentence.pitch = { range: round1(quantile(spread, 0.9) - quantile(spread, 0.1)), end }
    const ids = Array.from({ length: to - from }, (_, k) => from + k).filter(i => words[i].st !== undefined && words[i].db !== undefined)
    if (ids.length < 3) return
    const x = ids.map(i => words[i].start / FLICKS), pitch = trend(x, ids.map(i => words[i].st!)), loud = trend(x, ids.map(i => words[i].db!))
    const pace = (i: number) => (words[i].end - words[i].start) / Math.max(1, words[i].text.replace(/[^\p{L}\p{N}]/gu, '').length)
    const typical = median(ids.map(pace))
    const best = ids.map((i, k) => ({ i, p: words[i].st! - pitch(x[k]), d: words[i].db! - loud(x[k]) }))
      .filter(e => f0[e.i].length >= 8 && e.p >= 2 && e.d >= 1.5 && pace(e.i) >= typical * 0.9)
      .sort((a, b) => b.p + b.d - a.p - a.d)[0]
    if (best) words[best.i].emphasis = true
  })
  return round1(median(all))
}
