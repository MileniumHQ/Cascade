/**
 * Agent-facing transcript: source analyses mapped through timeline clips, rendered as compact
 * text with stable word/sentence ids, plus cut planning (words → ripple ranges).
 */
import type { AnalysisPart, AnalysisSentence, SourceAnalysis } from '@shared/analysis'
import { clipEnd, type Clip, type Id, type Project, type Track } from '@shared/project'
import { FLICKS, type Flicks, type FrameRate } from '@shared/time'
import { clock } from './clock'
import { constantMap, sourceSpan, type TimeMap } from '@core/time-remap'

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

const LOUD_DB = 6
const QUIET_DB = -16
const PAUSE_SHOWN = 0.5 * FLICKS

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

/** Word markup: {um} filler, *word* stressed or much louder, _word_ very quiet, word? low confidence. */
function markup(w: TWord) {
  let t = w.text
  if (w.filler) return `{${t}}`
  if (w.emphasis || w.db !== undefined && w.db >= LOUD_DB) t = `*${t}*`
  else if (w.db !== undefined && w.db <= QUIET_DB) t = `_${t}_`
  if (w.p < 0.4) t += '?'
  return t
}
const signed = (v: number, unit: string) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}${unit}`
/** Intonation tags, relative to how this source's speaker usually varies pitch. Only notable cases are shown. */
function showPitch(s: TSentence, typical: number) {
  if (!s.pitch) return ''
  const long = s.end - s.start >= 1.5 * FLICKS
  const tag = s.pitch.range >= Math.max(8, typical * 1.5) ? ' [lively]' : long && s.pitch.range <= Math.min(3, typical * 0.6) ? ' [flat]' : ''
  return tag + (s.pitch.end === 'rise' ? ' ↗' : '')
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

export interface FormatOptions {
  /** First line; defaults to the timeline legend. */
  legend?: string
  fps: FrameRate
  view: 'sentences' | 'words'
  start?: Flicks
  end?: Flicks
  clipId?: Id
  maxLines: number
  /** Items (sentences, pauses, events, cuts) to skip, for paging. */
  offset?: number
  wordId: (w: TWord) => string
  sentenceId: (s: TSentence) => string
  clipLabel: (c: Clip) => string
  trackLabel: (t: Track) => string
}

export const SOURCE_LEGEND = 'Source time (not on the timeline). m#:w#/m#:s# ids are source anchors for add_clip sourceIn/sourceOut (m1:w12.start-40ms, m1:s3.end+80ms). Markup as in the timeline transcript: {um}=filler, *word*=stressed, _word_=very quiet, word?=low confidence, [lively]/[flat], ↗=rising ending, ⏸ pause, ✂ shot cut, [CUE] sound event.'
export const TRANSCRIPT_LEGEND = 'Timeline time. w#/s# ids are anchors for any time in timeline_apply_edits/frame_get (w12, w12.end, s3.start, w12.end+80ms). {um}=filler, *word*=stressed (pitch and loudness peak above the sentence trend; conservative, ≤1 per sentence; or ≥ +6 dB louder), _word_=very quiet (≤ -16 dB, may be hard to hear), word?=low confidence, [lively]/[flat]=pitch variation vs the speaker’s norm, ↗=rising ending (question, uncertainty, list continuing), (part)=sentence partly outside the clip. ⏸ pause, ✂ shot cut, [CUE] sound event.'

export function formatTranscript(index: TIndex, o: FormatOptions): string {
  const tc = (t: Flicks) => clock(t)
  const lo = o.start ?? 0, hi = o.end ?? Number.MAX_SAFE_INTEGER
  const inRange = (a: Flicks, b: Flicks) => b > lo && a < hi
  const clipOk = (id: Id) => !o.clipId || id === o.clipId || index.clips.some((c) => c.clip.id === id && c.clip.linkId && index.clips.some((d) => d.clip.id === o.clipId && d.clip.linkId === c.clip.linkId))
  const lines: string[] = [o.legend ?? TRANSCRIPT_LEGEND]
  for (const c of index.clips) {
    if (!clipOk(c.clip.id) || !inRange(c.clip.start, clipEnd(c.clip))) continue
    lines.push(`${o.clipLabel(c.clip)} ${JSON.stringify(c.mediaName)} on ${o.trackLabel(c.track)} ${tc(c.clip.start)}–${tc(clipEnd(c.clip))} source ${tc(c.clip.sourceIn)}${c.speed === null ? ' speed keyframed' : c.speed !== 1 ? ` speed ${+c.speed.toFixed(3)}` : ''} · ${c.role === 'shots' ? 'shots only (speech on linked audio)' : `analysis: ${c.parts.join(', ')}`}`)
  }
  for (const u of index.unanalyzed) if (clipOk(u.clip.id) && inRange(u.clip.start, clipEnd(u.clip))) lines.push(`${o.clipLabel(u.clip)} on ${o.trackLabel(u.track)}: not analyzed. Run media_analyze.`)
  type Item = { t: Flicks; line: () => string[] }
  const items: Item[] = []
  const sentences = index.sentences.filter((s) => clipOk(s.clipId) && inRange(s.start, s.end))
  // Allocate ids in time order up front so a sentence's w#–w# range is contiguous and readable.
  for (const s of sentences) { o.sentenceId(s); for (const w of s.words) o.wordId(w) }
  const ranges = index.sentences.flatMap((s) => s.pitch ? [s.pitch.range] : []).sort((a, b) => a - b)
  const typical = ranges[(ranges.length - 1) >> 1] ?? 0
  for (const s of sentences) {
    const first = o.wordId(s.words[0]), last = o.wordId(s.words.at(-1)!)
    items.push({ t: s.start, line: () => {
      const head = `${o.sentenceId(s)} ${tc(s.start)}–${tc(s.end)} ${first}${s.words.length > 1 ? `–${last}` : ''}${s.speaker !== undefined ? ` S${s.speaker + 1}` : ''}${showPitch(s, typical)}${s.partial ? ' (part)' : ''} `
      if (o.view === 'sentences') return [head + s.words.map(markup).join(' ')]
      return [head, ...s.words.map((w) => `  ${o.wordId(w)} ${tc(w.start)}–${tc(w.end)} ${markup(w)}${w.st !== undefined ? ` ${signed(w.st, 'st')}` : ''}${w.db !== undefined ? ` ${signed(w.db, 'dB')}` : ''}`)]
    } })
  }
  // Pauses between consecutive shown words (only notable ones).
  const words = sentences.flatMap((s) => s.words)
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap >= PAUSE_SHOWN) items.push({ t: words[i - 1].end + 1, line: () => [`  ⏸ ${(gap / FLICKS).toFixed(2)}s ${o.wordId(words[i - 1])}.end → ${o.wordId(words[i])}.start`] })
  }
  for (const e of index.events) if (clipOk(e.clipId) && inRange(e.start, e.end)) items.push({ t: e.start, line: () => [`[${e.cue} ${tc(e.start)}–${tc(e.end)} ${e.score.toFixed(2).slice(1)}${e.underSpeech ? ' under speech' : ''}]`] })
  for (const s of index.shots) if (clipOk(s.clipId) && s.t >= lo && s.t < hi) items.push({ t: s.t, line: () => [`✂ ${tc(s.t)}`] })
  items.sort((a, b) => a.t - b.t)
  const skip = o.offset ?? 0
  if (skip) lines.push(`(skipped the first ${Math.min(skip, items.length)} items)`)
  let shown = skip
  for (const item of items.slice(skip)) {
    const add = item.line()
    if (lines.length + add.length > o.maxLines) {
      lines.push(`… truncated at ${tc(item.t)} (${items.length - shown} more items). Continue with offset=${shown}.`)
      break
    }
    lines.push(...add); shown++
  }
  if (!items.length) lines.push(index.clips.length || o.legend ? 'No speech, events or shots in this range.' : 'No analyzed clips. Use media_analyze on the sources (media_list), then retry.')
  return lines.join('\n')
}

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')
export const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean)

/**
 * Where `text` is spoken: runs of `words` (time order) matching its tokens in order, skipping up to
 * two unmatched words (fillers, misrecognitions) between tokens and tolerating a quarter of the
 * tokens missing. Returns [first, last] word indexes of every run.
 */
export function findSpoken(words: TWord[], text: string, from = 0): [number, number][] {
  const want = tokens(text)
  if (!want.length) return []
  const runs: [number, number][] = []
  const allowedMisses = Math.floor(want.length / 4)
  for (let i = from; i < words.length; i++) {
    if (norm(words[i].text) !== want[0] && (allowedMisses === 0 || norm(words[i].text) !== want[1])) continue
    let j = i, misses = 0, last = i, k = norm(words[i].text) === want[0] ? 1 : 2
    if (k === 2) misses++
    for (; k < want.length && misses <= allowedMisses; k++) {
      let found = -1
      for (let x = j + 1; x <= Math.min(words.length - 1, j + 3); x++) if (norm(words[x].text) === want[k]) { found = x; break }
      if (found < 0) { misses++; continue }
      j = last = found
    }
    // Runs don't overlap: continue after this one.
    if (misses <= allowedMisses) { runs.push([i, last]); i = last }
  }
  return runs
}

/** Phrase search over word tokens (punctuation/case-insensitive), or a regex over sentence text. */
export function searchTranscript(index: TIndex, query: string, regex: boolean, any = false): { sentence: TSentence; from: number; to: number }[] {
  const hits: { sentence: TSentence; from: number; to: number }[] = []
  if (regex) {
    const re = new RegExp(query, 'i')
    for (const s of index.sentences) if (re.test(s.words.map((w) => w.text).join(' '))) hits.push({ sentence: s, from: 0, to: s.words.length - 1 })
    return hits
  }
  const q = query.split(/\s+/).map(norm).filter(Boolean)
  if (!q.length) return hits
  if (any) {
    for (const s of index.sentences) s.words.forEach((w, i) => { if (q.includes(norm(w.text))) hits.push({ sentence: s, from: i, to: i }) })
    return hits.sort((a, b) => a.sentence.words[a.from].start - b.sentence.words[b.from].start)
  }
  // Match across sentence boundaries within one clip by scanning the flat word list.
  const words = index.words
  const owner = new Map<TWord, TSentence>()
  for (const s of index.sentences) for (const w of s.words) owner.set(w, s)
  for (let i = 0; i + q.length <= words.length; i++) {
    if (q.every((t, k) => norm(words[i + k].text) === t && words[i + k].clipId === words[i].clipId)) {
      const s = owner.get(words[i])!
      hits.push({ sentence: s, from: s.words.indexOf(words[i]), to: s.words.indexOf(words[i]) + q.length - 1 })
    }
  }
  return hits
}
