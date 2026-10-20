/**
 * Agent-facing transcript: source analyses mapped through timeline clips, rendered as compact
 * text with stable word/sentence ids, plus cut planning (words → ripple ranges).
 */
import type { AnalysisPart, SourceAnalysis, ToneLabel } from '@shared/analysis'
import { clipEnd, type Clip, type Id, type Project, type Track } from '@shared/project'
import { FLICKS, formatTimecode, type Flicks, type FrameRate } from '@shared/time'

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
  tone?: { label: ToneLabel; confidence: number }
  speaker?: number
}
export interface TEvent { cue: string; start: Flicks; end: Flicks; score: number; underSpeech: boolean; clipId: Id }
export interface TClip { clip: Clip; track: Track; mediaName: string; parts: AnalysisPart[]; role: 'speech' | 'shots' | 'both' }
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
const QUIET_DB = -10
const TONE_MIN = 0.5
const PAUSE_SHOWN = 0.5 * FLICKS

/** Analyses usable for a source range, widest first; later ones only fill gaps. */
function pick(list: SourceAnalysis[] | undefined, from: Flicks, to: Flicks) {
  return (list ?? []).filter((a) => a.range.start < to && a.range.end > from).sort((a, b) => (b.range.end - b.range.start) - (a.range.end - a.range.start))
}
function covered(ranges: { start: Flicks; end: Flicks }[], t: Flicks) { return ranges.some((r) => t >= r.start && t < r.end) }

export function buildIndex(project: Project, analyses: Analyses): TIndex {
  const tl = project.timelines[project.activeTimeline]
  const out: TIndex = { words: [], sentences: [], events: [], shots: [], clips: [], unanalyzed: [] }
  if (!tl) return out
  // A linked video+audio pair is one source: speech/events come from the audio clip, shots from the video.
  const linkedAudio = new Set(tl.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips.filter((c) => c.linkId && c.mediaId).map((c) => `${c.linkId}|${c.mediaId}`)))
  for (const track of tl.tracks) {
    for (const clip of track.clips) {
      const media = clip.mediaId ? project.media[clip.mediaId] : undefined
      if (!media?.path || !(media.type === 'video' || media.type === 'audio')) continue
      const speed = clip.speed ?? 1
      const srcStart = clip.sourceIn, srcEnd = clip.sourceIn + clip.duration * speed
      const toTimeline = (src: Flicks) => Math.min(clipEnd(clip), Math.max(clip.start, clip.start + Math.round((src - clip.sourceIn) / speed)))
      const inClip = (src: Flicks) => src >= srcStart && src < srcEnd
      const list = pick(analyses.get(media.path), srcStart, srcEnd)
      if (!list.length) { out.unanalyzed.push({ clip, track }); continue }
      const speech = track.kind === 'audio' || !(clip.linkId && linkedAudio.has(`${clip.linkId}|${clip.mediaId}`))
      const shots = track.kind === 'visual'
      out.clips.push({ clip, track, mediaName: media.name, parts: [...new Set(list.flatMap((a) => a.parts))], role: speech && shots ? 'both' : speech ? 'speech' : 'shots' })
      const used: { start: Flicks; end: Flicks }[] = []
      for (const a of list) {
        const fresh = (src: Flicks) => inClip(src) && src >= a.range.start && src < a.range.end && !covered(used, src)
        if (speech) {
          for (const s of a.sentences) {
            const words: TWord[] = []
            for (let i = s.words[0]; i < s.words[1]; i++) {
              const w = a.words[i]
              if (!w || !fresh((w.start + w.end) / 2)) continue
              words.push({ key: `${clip.mediaId}|${track.id}|${w.start}`, clipId: clip.id, trackId: track.id, text: w.text, start: toTimeline(w.start), end: toTimeline(w.end), filler: !!w.filler, db: w.db, p: w.p })
            }
            if (!words.length) continue
            out.words.push(...words)
            out.sentences.push({ key: `${clip.mediaId}|${track.id}|s${s.start}`, clipId: clip.id, start: words[0].start, end: words.at(-1)!.end, words,
              partial: words.length < s.words[1] - s.words[0], tone: s.tone, speaker: s.speaker })
          }
          for (const e of a.events) {
            const from = Math.max(e.start, srcStart), to = Math.min(e.end, srcEnd)
            if (to <= from || covered(used, from)) continue
            out.events.push({ cue: e.cue, start: toTimeline(from), end: toTimeline(to), score: e.score, underSpeech: !!e.underSpeech, clipId: clip.id })
          }
        }
        if (shots) for (const t of a.shots) if (fresh(t) && t > srcStart) out.shots.push({ t: toTimeline(t), clipId: clip.id })
        used.push(a.range)
      }
    }
  }
  const byStart = <T extends { start: Flicks }>(x: T[]) => x.sort((a, b) => a.start - b.start)
  byStart(out.words); byStart(out.sentences); byStart(out.events)
  out.shots.sort((a, b) => a.t - b.t)
  return out
}

/** Word markup: {um} filler, *word* louder, _word_ quieter, word? low confidence. */
function markup(w: TWord) {
  let t = w.text
  if (w.filler) return `{${t}}`
  if (w.db !== undefined && w.db >= LOUD_DB) t = `*${t}*`
  else if (w.db !== undefined && w.db <= QUIET_DB) t = `_${t}_`
  if (w.p < 0.4) t += '?'
  return t
}
const showTone = (s: TSentence) => s.tone && s.tone.label !== 'neutral' && s.tone.confidence >= TONE_MIN ? ` [${s.tone.label} ${s.tone.confidence.toFixed(2).slice(1)}]` : ''

export interface FormatOptions {
  fps: FrameRate
  view: 'sentences' | 'words'
  start?: Flicks
  end?: Flicks
  clipId?: Id
  maxLines: number
  wordId: (w: TWord) => string
  sentenceId: (s: TSentence) => string
  clipLabel: (c: Clip) => string
  trackLabel: (t: Track) => string
}

export const TRANSCRIPT_LEGEND = 'Timeline time. w#/s# ids are anchors for any time in timeline_apply_edits/frame_get (w12, w12.end, s3.start, w12.end+80ms). {um}=filler, *word*=louder (+6 dB), _word_=quieter (-10 dB), word?=low confidence, [tone .conf] only when non-neutral, (part)=sentence partly outside the clip. ⏸ pause, ✂ shot cut, [CUE] sound event.'

export function formatTranscript(index: TIndex, o: FormatOptions): string {
  const tc = (t: Flicks) => formatTimecode(t, o.fps)
  const lo = o.start ?? 0, hi = o.end ?? Number.MAX_SAFE_INTEGER
  const inRange = (a: Flicks, b: Flicks) => b > lo && a < hi
  const clipOk = (id: Id) => !o.clipId || id === o.clipId || index.clips.some((c) => c.clip.id === id && c.clip.linkId && index.clips.some((d) => d.clip.id === o.clipId && d.clip.linkId === c.clip.linkId))
  const lines: string[] = [TRANSCRIPT_LEGEND]
  for (const c of index.clips) {
    if (!clipOk(c.clip.id) || !inRange(c.clip.start, clipEnd(c.clip))) continue
    lines.push(`${o.clipLabel(c.clip)} ${JSON.stringify(c.mediaName)} on ${o.trackLabel(c.track)} ${tc(c.clip.start)}–${tc(clipEnd(c.clip))} source ${tc(c.clip.sourceIn)}${(c.clip.speed ?? 1) !== 1 ? ` speed ${c.clip.speed}` : ''} · ${c.role === 'shots' ? 'shots only (speech on linked audio)' : `analysis: ${c.parts.join(', ')}`}`)
  }
  for (const u of index.unanalyzed) if (clipOk(u.clip.id) && inRange(u.clip.start, clipEnd(u.clip))) lines.push(`${o.clipLabel(u.clip)} on ${o.trackLabel(u.track)}: not analyzed. Run media_analyze.`)
  type Item = { t: Flicks; line: () => string[] }
  const items: Item[] = []
  const sentences = index.sentences.filter((s) => clipOk(s.clipId) && inRange(s.start, s.end))
  // Allocate ids in time order up front so a sentence's w#–w# range is contiguous and readable.
  for (const s of sentences) { o.sentenceId(s); for (const w of s.words) o.wordId(w) }
  for (const s of sentences) {
    const first = o.wordId(s.words[0]), last = o.wordId(s.words.at(-1)!)
    items.push({ t: s.start, line: () => {
      const head = `${o.sentenceId(s)} ${tc(s.start)}–${tc(s.end)} ${first}${s.words.length > 1 ? `–${last}` : ''}${s.speaker !== undefined ? ` S${s.speaker + 1}` : ''}${showTone(s)}${s.partial ? ' (part)' : ''} `
      if (o.view === 'sentences') return [head + s.words.map(markup).join(' ')]
      return [head, ...s.words.map((w) => `  ${o.wordId(w)} ${tc(w.start)} ${markup(w)}`)]
    } })
  }
  // Pauses between consecutive shown words (only notable ones).
  const words = sentences.flatMap((s) => s.words)
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap >= PAUSE_SHOWN) items.push({ t: words[i - 1].end + 1, line: () => [`  ⏸ ${(gap / FLICKS).toFixed(2)}s`] })
  }
  for (const e of index.events) if (clipOk(e.clipId) && inRange(e.start, e.end)) items.push({ t: e.start, line: () => [`[${e.cue} ${tc(e.start)}–${tc(e.end)} ${e.score.toFixed(2).slice(1)}${e.underSpeech ? ' under speech' : ''}]`] })
  for (const s of index.shots) if (clipOk(s.clipId) && s.t >= lo && s.t < hi) items.push({ t: s.t, line: () => [`✂ ${tc(s.t)}`] })
  items.sort((a, b) => a.t - b.t)
  let shown = 0
  for (const item of items) {
    const add = item.line()
    if (lines.length + add.length > o.maxLines) {
      lines.push(`… truncated at ${tc(item.t)} (${items.length - shown} more items). Continue with start=${item.t}.`)
      break
    }
    lines.push(...add); shown++
  }
  if (!items.length) lines.push(index.clips.length ? 'No speech, events or shots in this range.' : 'No analyzed clips. Use media_analyze on the sources (media_list), then retry.')
  return lines.join('\n')
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')

/** Phrase search over word tokens (punctuation/case-insensitive), or a regex over sentence text. */
export function searchTranscript(index: TIndex, query: string, regex: boolean): { sentence: TSentence; from: number; to: number }[] {
  const hits: { sentence: TSentence; from: number; to: number }[] = []
  if (regex) {
    const re = new RegExp(query, 'i')
    for (const s of index.sentences) if (re.test(s.words.map((w) => w.text).join(' '))) hits.push({ sentence: s, from: 0, to: s.words.length - 1 })
    return hits
  }
  const q = query.split(/\s+/).map(norm).filter(Boolean)
  if (!q.length) return hits
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
