/**
 * Timeline/source transcript index: cached source analyses mapped through timeline clips into
 * words, sentences, events and shots with stable keys. Shared by the editor's audio tools and the
 * agent (MCP) transcript tools; knows nothing about media types.
 */
import type { AnalysisPart, AnalysisSentence, SourceAnalysis } from '@shared/analysis'
import { clipEnd, type Clip, type Id, type Project, type Track } from '@shared/project'
import { FLICKS, type Flicks } from '@shared/time'
import { constantMap, sourceSpan, type TimeMap } from './time-remap'

/** Cached analyses per source file path. */
export type Analyses = Map<string, SourceAnalysis[]>

export interface TWord {
  /** Stable identity: media + track + source start. Survives ripple edits and re-analysis. */
  key: string
  clipId: Id
  trackId: Id
  text: string
  start: Flicks
  end: Flicks
  filler: boolean
  db?: number
  st?: number
  emphasis: boolean
  p: number
}
export interface TSentence {
  key: string
  clipId: Id
  start: Flicks
  end: Flicks
  words: TWord[]
  /** Some of the source sentence's words are outside the clip (trimmed or cut). */
  partial: boolean
  pitch?: AnalysisSentence['pitch']
  speaker?: number
}
export interface TEvent { cue: string; start: Flicks; end: Flicks; score: number; underSpeech: boolean; clipId: Id }
export interface TClip { clip: Clip; track: Track; mediaName: string; parts: AnalysisPart[]; role: 'speech' | 'shots' | 'both'; /** Constant speed, or null when keyframed. */ speed: number | null }
export interface TIndex {
  words: TWord[]
  sentences: TSentence[]
  events: TEvent[]
  shots: { t: Flicks; clipId: Id }[]
  clips: TClip[]
  /** Time-based clips whose source has no analysis covering them. */
  unanalyzed: { clip: Clip; track: Track }[]
}

/** Analyses usable for a source range, widest first; later ones only fill gaps. */
function pick(list: SourceAnalysis[] | undefined, from: Flicks, to: Flicks) {
  return (list ?? []).filter((a) => a.range.start < to && a.range.end > from).sort((a, b) => (b.range.end - b.range.start) - (a.range.end - a.range.start))
}
function covered(ranges: { start: Flicks; end: Flicks }[], t: Flicks) { return ranges.some((r) => t >= r.start && t < r.end) }

/** `timeMap` gives each clip's (possibly keyframed) speed mapping; defaults to `clip.speed`. */
export function buildIndex(project: Project, analyses: Analyses, timeMap: (clip: Clip) => TimeMap = (c) => constantMap(c.speed ?? 1)): TIndex {
  const tl = project.timelines[project.activeTimeline]
  const out: TIndex = { words: [], sentences: [], events: [], shots: [], clips: [], unanalyzed: [] }
  if (!tl) return out
  // A linked video+audio pair is one source: speech/events come from the audio clip, shots from the video.
  const linkedAudio = new Set(tl.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips.filter((c) => c.linkId && c.mediaId).map((c) => `${c.linkId}|${c.mediaId}`)))
  for (const track of tl.tracks) {
    for (const clip of track.clips) {
      const media = clip.mediaId ? project.media[clip.mediaId] : undefined
      if (!media?.path || !(media.type === 'video' || media.type === 'audio')) continue
      const map = timeMap(clip)
      const { lo: srcStart, hi: srcEnd } = sourceSpan(clip, map)
      const toTimeline = (src: Flicks) => Math.min(clipEnd(clip), Math.max(clip.start, clip.start + Math.round(map.localAt(src - clip.sourceIn))))
      // A reversed clip plays a word's end before its start.
      const span = (a: Flicks, b: Flicks) => (map.reversed ? { start: toTimeline(b), end: toTimeline(a) } : { start: toTimeline(a), end: toTimeline(b) })
      const inClip = (src: Flicks) => src >= srcStart && src < srcEnd
      const list = pick(analyses.get(media.path), srcStart, srcEnd)
      if (!list.length) { out.unanalyzed.push({ clip, track }); continue }
      const speech = track.kind === 'audio' || !(clip.linkId && linkedAudio.has(`${clip.linkId}|${clip.mediaId}`))
      const shots = track.kind === 'visual'
      out.clips.push({ clip, track, mediaName: media.name, parts: [...new Set(list.flatMap((a) => a.parts))], role: speech && shots ? 'both' : speech ? 'speech' : 'shots', speed: map.constant })
      const used: { start: Flicks; end: Flicks }[] = []
      for (const a of list) {
        const fresh = (src: Flicks) => inClip(src) && src >= a.range.start && src < a.range.end && !covered(used, src)
        if (speech) {
          for (const s of a.sentences) {
            const words: TWord[] = []
            for (let i = s.words[0]; i < s.words[1]; i++) {
              const w = a.words[i]
              if (!w || !fresh((w.start + w.end) / 2)) continue
              words.push({ key: `${clip.mediaId}|${track.id}|${w.start}`, clipId: clip.id, trackId: track.id, text: w.text, ...span(w.start, w.end), filler: !!w.filler, db: w.db, st: w.st, emphasis: !!w.emphasis, p: w.p })
            }
            if (!words.length) continue
            if (map.reversed) words.reverse()
            out.words.push(...words)
            out.sentences.push({ key: `${clip.mediaId}|${track.id}|s${s.start}`, clipId: clip.id, start: words[0].start, end: words.at(-1)!.end, words,
              partial: words.length < s.words[1] - s.words[0], pitch: s.pitch, speaker: s.speaker })
          }
          for (const e of a.events) {
            const from = Math.max(e.start, srcStart), to = Math.min(e.end, srcEnd)
            if (to <= from || covered(used, from)) continue
            out.events.push({ cue: e.cue, ...span(from, to), score: e.score, underSpeech: !!e.underSpeech, clipId: clip.id })
          }
        }
        if (shots) for (const t of a.shots) if (fresh(t) && t > srcStart) out.shots.push({ t: toTimeline(t), clipId: clip.id })
        used.push(a.range)
      }
    }
  }
  const byStart = <T extends { start: Flicks }>(x: T[]) => x.sort((a, b) => a.start - b.start)
  byStart(out.words); byStart(out.sentences); byStart(out.events)
  // The same source moment placed twice on a track (repeats, stutters) gets #2, #3… in timeline order.
  const unique = (items: { key: string }[]) => {
    const seen = new Map<string, number>()
    for (const x of items) {
      const n = (seen.get(x.key) ?? 0) + 1
      seen.set(x.key, n)
      if (n > 1) x.key += `#${n}`
    }
  }
  unique(out.words); unique(out.sentences)
  out.shots.sort((a, b) => a.t - b.t)
  return out
}

/**
 * A source's own transcript, in source time, merged across its cached analyses (widest first,
 * later ones fill gaps). Words and sentences are numbered by position (1-based) for source anchors.
 */
export interface SourceIndex extends TIndex {
  wordNo: Map<TWord, number>
  sentenceNo: Map<TSentence, number>
}
export function buildSourceIndex(mediaId: Id, list: SourceAnalysis[] | undefined): SourceIndex {
  const out: SourceIndex = { words: [], sentences: [], events: [], shots: [], clips: [], unanalyzed: [], wordNo: new Map(), sentenceNo: new Map() }
  const used: { start: Flicks; end: Flicks }[] = []
  for (const a of pick(list, 0, Number.MAX_SAFE_INTEGER)) {
    const fresh = (t: Flicks) => t >= a.range.start && t < a.range.end && !covered(used, t)
    for (const s of a.sentences) {
      const words: TWord[] = []
      for (let i = s.words[0]; i < s.words[1]; i++) {
        const w = a.words[i]
        if (w && fresh((w.start + w.end) / 2)) words.push({ key: `${mediaId}|src|${w.start}`, clipId: '', trackId: '', text: w.text, start: w.start, end: w.end, filler: !!w.filler, db: w.db, st: w.st, emphasis: !!w.emphasis, p: w.p })
      }
      if (!words.length) continue
      out.sentences.push({ key: `${mediaId}|src|s${s.start}`, clipId: '', start: words[0].start, end: words.at(-1)!.end, words, partial: words.length < s.words[1] - s.words[0], pitch: s.pitch, speaker: s.speaker })
    }
    for (const e of a.events) if (fresh(e.start)) out.events.push({ cue: e.cue, start: e.start, end: e.end, score: e.score, underSpeech: !!e.underSpeech, clipId: '' })
    for (const t of a.shots) if (fresh(t)) out.shots.push({ t, clipId: '' })
    used.push(a.range)
  }
  out.sentences.sort((a, b) => a.start - b.start)
  out.sentences.forEach((s, i) => out.sentenceNo.set(s, i + 1))
  out.words = out.sentences.flatMap((s) => s.words)
  out.words.forEach((w, i) => out.wordNo.set(w, i + 1))
  out.events.sort((a, b) => a.start - b.start)
  out.shots.sort((a, b) => a.t - b.t)
  return out
}
