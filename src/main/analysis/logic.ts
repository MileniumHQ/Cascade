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
