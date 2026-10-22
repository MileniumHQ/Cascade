/**
 * Timeline lint: measurable problems in an edit (text off the safe area or overflowing its box,
 * captions too fast, silent or clipping audio, dead air, black or frozen frames, gaps…), each with
 * the clips involved and a fix phrased as MCP edit ops. Pure: audio/frame measurements come in.
 */
import type { CascadeAPI } from '@core/app'
import { evaluateParam } from '@core/evaluate'
import { sourceSpan } from '@core/time-remap'
import { clipEnd, type Clip, type Id, type Track } from '@shared/project'
import { FLICKS, frameDuration, type Flicks } from '@shared/time'
import { clock } from './clock'

export interface LintIssue { rule: string; severity: 'error' | 'warning' | 'info'; start: Flicks; end: Flicks; clipIds: Id[]; message: string; suggestedFix?: string }
export interface LintMeasurements {
  /** Per audio clip, its own source audio (not the mix): sample peak dBFS and loudest 400 ms LUFS. */
  clipLevels?: Map<Id, { peak: number; momentaryMax: number }>
  /** Rendered-mix measurements over [range.start, range.end): silent stretches and clipped sample times, timeline flicks. */
  mixSilences?: [Flicks, Flicks][]
  mixClipping?: Flicks[]
  /** Sampled rendered frames: mean luma 0–1 and mean abs difference to the previous sample 0–1. */
  frames?: { t: Flicks; luma: number; diff: number }[]
  /** Text width in px for a font string like `700 40px "Inter"` (canvas measureText in the renderer). */
  measureText?: (text: string, font: string) => number
}

export const LINT_RULES: { id: string; description: string }[] = [
  { id: 'safe-area', description: 'Text outside the 90% title-safe area' },
  { id: 'text-overflow', description: 'Text taller than its box, or a word wider than it' },
  { id: 'text-overlap', description: 'Two text boxes on screen at once and overlapping' },
  { id: 'reading-speed', description: 'Text faster than 20 characters per second' },
  { id: 'text-dwell', description: 'Text too short to read, or a title held over 10 s' },
  { id: 'silent-clip', description: 'Audio clip whose own source range is silent (needs clip levels)' },
  { id: 'clipping', description: 'Clipped samples in a clip source or the mix (needs audio measurements)' },
  { id: 'dead-air', description: 'Silence of 1 s or more in the mix (needs mix measurements)' },
  { id: 'missing-linked-audio', description: 'Video with sound whose linked audio is not on the timeline' },
  { id: 'black-frame', description: 'Black picture away from the start/end fades (needs frame samples)' },
  { id: 'freeze', description: 'Picture frozen for 2 s or more inside a video clip (needs frame samples)' },
  { id: 'cut-rhythm', description: 'Shot lengths on the top video track: holds over 8 s, runs of cuts under 0.4 s' },
  { id: 'repeated-media', description: 'Two clips using overlapping ranges of the same source' },
  { id: 'gap', description: 'Empty (black) time on every visual track inside the edit' }
]

const SEVERITY = { error: 0, warning: 1, info: 2 }
/** Title-safe area: the central 90% of the frame. */
export const TITLE_SAFE = 0.9
const SAFE = TITLE_SAFE
const sec = (t: Flicks) => +(t / FLICKS).toFixed(2)
const round = (v: number) => Math.round(v * 1000) / 1000

interface Rect { x0: number; y0: number; x1: number; y1: number }

type Measure = (text: string, font: string) => number
const num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? v : d
const vec = (v: unknown, d: [number, number]): [number, number] => Array.isArray(v) && v.length === 2 ? [num(v[0], d[0]), num(v[1], d[1])] : d
/** Evaluated parameter (clip-local time), or undefined when the property is missing/off. */
function param(app: CascadeAPI, clip: Clip, type: string, paramId: string, local: Flicks): unknown {
  const prop = clip.properties.find(p => p.type === type && p.enabled)
  if (!prop) return undefined
  const def = app.edit.paramDef(type, paramId)
  if (!def) return prop.params[paramId]?.value
  return evaluateParam(app.registries, def, prop.params[paramId], local)
}
const textOf = (app: CascadeAPI, c: Clip) => {
  const t = param(app, c, 'text', 'text', 0)
  return typeof t === 'string' ? t : undefined
}
interface Layout { box: Rect; text: Rect; lines: number; overflowY: boolean; wideWord?: string }
/** An element's box and text block in reference px (mirrors the stage: a flex box, text centered vertically, wrapped at the box width). */
function layout(app: CascadeAPI, c: Clip, local: Flicks, measure?: Measure): Layout {
  const W = app.project().settings.width, H = app.project().settings.height
  const p = (type: string, id: string) => param(app, c, type, id, local)
  const text = String(p('text', 'text') ?? '')
  const fontPx = num(p('text', 'size'), 0.08) * H
  const weight = Math.round(num(p('text', 'weight'), 700))
  const family = String(p('text', 'font') ?? 'Inter')
  const tracking = num(p('text', 'tracking'), 0) * fontPx
  const leading = num(p('text', 'leading'), 1.15)
  const italic = p('text', 'italic') === true
  const align = String(p('text', 'align') ?? 'center')
  const font = `${italic ? 'italic ' : ''}${weight} ${fontPx}px "${family}"`
  const width = (s: string) => (measure ? measure(s, font) : s.length * 0.55 * fontPx) + tracking * s.length
  const sized = c.properties.some(x => x.type === 'size' && x.enabled)
  const [sw, sh] = vec(p('size', 'size'), [0.5, 0.5])
  const padding = sized ? num(p('size', 'padding'), 0) * H : 0
  // Without a size the box is absolutely placed at the frame center, so it wraps at half the frame width.
  const maxW = sized ? Math.max(0, sw * W - 2 * padding) : 0.5 * W
  let lines = 0, widest = 0, wideWord: string | undefined
  if (text) for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/ +/)) {
      if (width(word) > maxW + 0.5 && !wideWord) wideWord = word
      const next = line ? `${line} ${word}` : word
      if (line && width(next) > maxW + 0.5) { lines++; widest = Math.max(widest, width(line)); line = word } else line = next
    }
    lines++; widest = Math.max(widest, width(line))
  }
  const textW = wideWord ? widest : Math.min(widest, maxW), textH = lines * leading * fontPx
  const boxW = sized ? sw * W : Math.min(widest, maxW), boxH = sized ? sh * H : textH
  // Transform: the anchor point lands at center + position; scale/rotation pivot around it.
  const [px, py] = vec(p('transform', 'position'), [0, 0])
  const [ax, ay] = vec(p('transform', 'anchor'), [0.5, 0.5])
  const k = num(p('transform', 'scale'), 1)
  const [sx, sy] = vec(p('transform', 'stretch'), [1, 1])
  const rot = num(p('transform', 'rotation'), 0) * Math.PI / 180
  const cx = W / 2 + px * W, cy = H / 2 + py * H
  const place = (x0: number, y0: number, x1: number, y1: number): Rect => {
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => {
      const dx = (x - ax * boxW) * k * sx, dy = (y - ay * boxH) * k * sy
      return [cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)]
    })
    return { x0: Math.min(...pts.map(q => q[0])), y0: Math.min(...pts.map(q => q[1])), x1: Math.max(...pts.map(q => q[0])), y1: Math.max(...pts.map(q => q[1])) }
  }
  const tx = align === 'left' ? padding : align === 'right' ? boxW - padding - textW : (boxW - textW) / 2
  const ty = (boxH - textH) / 2
  return { box: place(0, 0, boxW, boxH), text: place(tx, ty, tx + textW, ty + textH), lines, overflowY: sized && textH > boxH - 2 * padding + 0.5, wideWord }
}

/** A clip's on-screen box at timeline time t, in frame fractions from the top-left; null for clips that aren't sized elements or text. */
export function elementBox(app: CascadeAPI, clip: Clip, t: Flicks, measure?: Measure): { x: number; y: number; w: number; h: number } | null {
  if (clip.type !== 'element') return null
  const sized = clip.properties.some(p => p.type === 'size' && p.enabled)
  if (!sized && textOf(app, clip) === undefined) return null
  const { width: W, height: H } = app.project().settings
  const local = Math.max(0, Math.min(clip.duration, t - clip.start))
  const r = layout(app, clip, local, measure).box
  return { x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0) / W, h: (r.y1 - r.y0) / H }
}

export function lintTimeline(app: CascadeAPI, range: { start: Flicks; end: Flicks }, m: LintMeasurements = {}, opts: { rules?: string[] } = {}): LintIssue[] {
  const project = app.project(), tl = app.timeline(), fps = project.settings.fps
  const W = project.settings.width, H = project.settings.height
  const want = (rule: string) => !opts.rules || opts.rules.includes(rule)
  const issues: LintIssue[] = []
  const add = (i: LintIssue) => {
    if (!want(i.rule)) return
    if (i.end > i.start ? i.start < range.end && i.end > range.start : i.start >= range.start && i.start < range.end) issues.push(i)
  }
  const id = (c: Clip) => c.id
  const mediaType = (c: Clip) => app.registries.mediaTypes.get(c.type)
  const visualTracks = tl.tracks.filter(t => t.kind === 'visual' && !t.hidden)
  const duration = Math.max(0, ...tl.tracks.flatMap(t => t.clips.map(clipEnd)))

  const isText = (c: Clip) => c.type === 'element' && textOf(app, c) !== undefined
  const isCaption = (c: Clip) => !!(c.data as { caption?: unknown } | undefined)?.caption
  const lay = (c: Clip, local: Flicks) => layout(app, c, local, m.measureText)
  const frac = (r: Rect) => `x ${round(r.x0 / W)}–${round(r.x1 / W)}, y ${round(r.y0 / H)}–${round(r.y1 / H)} of the frame`

  const textClips = visualTracks.flatMap(t => t.clips.filter(isText).map(c => ({ c, t })))
  const samples = (c: Clip) => [...new Set([0, Math.floor(c.duration / 2), Math.max(0, c.duration - frameDuration(fps))])]
  for (const { c } of textClips) {
    if (clipEnd(c) <= range.start || c.start >= range.end) continue
    // safe-area
    for (const local of samples(c)) {
      const l = lay(c, local)
      const safe: Rect = { x0: W * (1 - SAFE) / 2, y0: H * (1 - SAFE) / 2, x1: W * (1 + SAFE) / 2, y1: H * (1 + SAFE) / 2 }
      const r = l.text
      if (r.x0 < safe.x0 - 0.5 || r.y0 < safe.y0 - 0.5 || r.x1 > safe.x1 + 0.5 || r.y1 > safe.y1 + 0.5) {
        const [px, py] = vec(param(app, c, 'transform', 'position', local), [0, 0])
        const dx = r.x0 < safe.x0 ? safe.x0 - r.x0 : r.x1 > safe.x1 ? safe.x1 - r.x1 : 0
        const dy = r.y0 < safe.y0 ? safe.y0 - r.y0 : r.y1 > safe.y1 ? safe.y1 - r.y1 : 0
        const fits = r.x1 - r.x0 <= safe.x1 - safe.x0 && r.y1 - r.y0 <= safe.y1 - safe.y0
        add({ rule: 'safe-area', severity: 'warning', start: c.start + local, end: clipEnd(c), clipIds: [id(c)],
          message: `Text "${short(textOf(app, c)!)}" reaches outside the 90% title-safe area at ${clock(c.start + local)} (${frac(r)}; safe is 0.05–0.95)`,
          suggestedFix: fits ? `set_param transform.position to [${round(px + dx / W)},${round(py + dy / H)}]` : 'set_param text.size smaller (or size.size narrower) so the text fits inside 0.9 of the frame' })
        break
      }
    }
    // text-overflow
    const l = lay(c, 0)
    if ((l.overflowY || l.wideWord)) {
      add({ rule: 'text-overflow', severity: 'warning', start: c.start, end: clipEnd(c), clipIds: [id(c)],
        message: l.wideWord ? `"${short(l.wideWord)}" is wider than the text box of "${short(textOf(app, c)!)}"` : `Text "${short(textOf(app, c)!)}" needs ${l.lines} lines and is taller than its box`,
        suggestedFix: 'set_param text.size smaller, or set_param size.size larger' })
    }
    // reading-speed / text-dwell
    const chars = textOf(app, c)!.replace(/\s+/g, ' ').trim().length
    const seconds = c.duration / FLICKS
    if (chars && chars / seconds > 20) {
      add({ rule: 'reading-speed', severity: 'warning', start: c.start, end: clipEnd(c), clipIds: [id(c)],
        message: `"${short(textOf(app, c)!)}" is ${Math.round(chars / seconds)} characters/s over ${sec(c.duration)} s (readable: up to 20, ideally 17)`,
        suggestedFix: `trim the end to ${clock(c.start + Math.round(chars / 17 * FLICKS))}, or shorten the text` })
    } else if (chars && seconds < Math.max(0.7, chars / 17)) {
      add({ rule: 'text-dwell', severity: 'warning', start: c.start, end: clipEnd(c), clipIds: [id(c)],
        message: `"${short(textOf(app, c)!)}" is on screen ${sec(c.duration)} s, too short to read (needs ${Math.max(0.7, chars / 17).toFixed(1)} s)`,
        suggestedFix: `trim the end to ${clock(c.start + Math.round(Math.max(0.7, chars / 17) * FLICKS))}` })
    } else if (!isCaption(c) && seconds > 10) {
      add({ rule: 'text-dwell', severity: 'info', start: c.start, end: clipEnd(c), clipIds: [id(c)],
        message: `Title "${short(textOf(app, c)!)}" stays on screen ${sec(c.duration)} s`, suggestedFix: 'trim it shorter unless it is meant to persist' })
    }
  }
  // text-overlap
  for (let i = 0; i < textClips.length; i++) for (let j = i + 1; j < textClips.length; j++) {
    const a = textClips[i].c, b = textClips[j].c
    const s = Math.max(a.start, b.start), e = Math.min(clipEnd(a), clipEnd(b))
    if (e <= s) continue
    const t = Math.floor((s + e) / 2)
    const la = lay(a, t - a.start), lb = lay(b, t - b.start)
    const x = Math.min(la.text.x1, lb.text.x1) - Math.max(la.text.x0, lb.text.x0), y = Math.min(la.text.y1, lb.text.y1) - Math.max(la.text.y0, lb.text.y0)
    if (x > 0.5 && y > 0.5) {
      // Move the lower one down by the overlap plus a small margin.
      const lower = la.text.y0 < lb.text.y0 ? b : a
      const [px, py] = vec(param(app, lower, 'transform', 'position', t - lower.start), [0, 0])
      add({ rule: 'text-overlap', severity: 'warning', start: s, end: e, clipIds: [id(a), id(b)],
        message: `"${short(textOf(app, a)!)}" and "${short(textOf(app, b)!)}" overlap on screen ${clock(s)}–${clock(e)}`,
        suggestedFix: `set_param transform.position on ${lower.id} to [${round(px)},${round(py + y / H + 0.01)}] (or move the other one up)` })
    }
  }

  // ── audio ──
  const audioClips = tl.tracks.filter(t => t.kind === 'audio' && !t.muted).flatMap(t => t.clips)
  for (const c of audioClips) {
    const level = m.clipLevels?.get(c.id)
    if (!level) continue
    if (level.momentaryMax < -50) add({ rule: 'silent-clip', severity: 'warning', start: c.start, end: clipEnd(c), clipIds: [id(c)],
      message: `${JSON.stringify(c.name)} ${clock(c.start)}–${clock(clipEnd(c))}: nothing audible in its source range (loudest ${fmt(level.momentaryMax)} LUFS)`,
      suggestedFix: 'move its sourceIn (trim/replace the source range) to where the sound is, or delete it' })
    if (level.peak > -0.1) add({ rule: 'clipping', severity: 'error', start: c.start, end: clipEnd(c), clipIds: [id(c)],
      message: `${JSON.stringify(c.name)} clips in its source (peak ${fmt(level.peak)} dBFS)`, suggestedFix: 'set_param volume.gain to -3 or lower' })
  }
  if (m.mixClipping?.length) {
    const times = [...m.mixClipping].sort((a, b) => a - b)
    let from = times[0], last = times[0]
    const flush = () => {
      const under = audioClips.filter(c => c.start <= last && clipEnd(c) > from).map(id)
      add({ rule: 'clipping', severity: 'error', start: from, end: Math.max(last, from + 1), clipIds: under,
        message: `The mix clips at ${clock(from)}${last > from ? `–${clock(last)}` : ''}`, suggestedFix: 'lower volume.gain on the loudest clips there (audio_analyze shows per-clip peaks)' })
    }
    for (const t of times.slice(1)) { if (t - last > FLICKS / 2) { flush(); from = t } last = t }
    flush()
  }
  for (const [s, e] of m.mixSilences ?? []) {
    if (e - s < FLICKS) continue
    const keep = Math.round(0.15 * FLICKS)
    add({ rule: 'dead-air', severity: 'warning', start: s, end: e, clipIds: audioClips.filter(c => c.start < e && clipEnd(c) > s).map(id),
      message: `${sec(e - s)} s of silence ${clock(s)}–${clock(e)}`, suggestedFix: `ripple_delete ${clock(s + keep)}–${clock(e - keep)}` })
  }

  // ── linked audio ──
  for (const tr of tl.tracks) for (const c of tr.clips) {
    const media = c.mediaId ? project.media[c.mediaId] : undefined
    if (tr.kind !== 'visual' || !mediaType(c)?.linkedAudioType || !media?.meta.hasAudio) continue
    const partner = c.linkId && tl.tracks.some(t => t.kind === 'audio' && t.clips.some(x => x.linkId === c.linkId))
    if (!partner) add({ rule: 'missing-linked-audio', severity: 'info', start: c.start, end: clipEnd(c), clipIds: [id(c)],
      message: `${JSON.stringify(c.name)} has sound in its source but no linked audio on the timeline`, suggestedFix: 'add_clip again with the same source range (it creates linked audio), unless the silence is intended' })
  }

  // ── frames ──
  const frames = [...(m.frames ?? [])].sort((a, b) => a.t - b.t)
  const runs = (test: (f: { luma: number; diff: number }) => boolean) => {
    const out: { from: number; to: number }[] = []
    let i = 0
    while (i < frames.length) {
      if (!test(frames[i])) { i++; continue }
      let j = i
      while (j + 1 < frames.length && test(frames[j + 1])) j++
      out.push({ from: i, to: j })
      i = j + 1
    }
    return out
  }
  const step = frames.length > 1 ? frames[1].t - frames[0].t : FLICKS
  const fade = FLICKS
  for (const r of runs(f => f.luma < 0.03)) {
    if (r.to === r.from) continue
    const s = frames[r.from].t, e = frames[r.to].t + step
    if (s <= fade || e >= duration - fade) continue
    add({ rule: 'black-frame', severity: 'warning', start: s, end: e, clipIds: clipsAt(visualTracks, s, e).map(id),
      message: `Black picture ${clock(s)}–${clock(e)}`, suggestedFix: 'check the clips there (a source range in black, a hidden/empty track); trim the black or cover it' })
  }
  const topVideo = (t: Flicks) => {
    for (const tr of [...visualTracks].reverse()) {
      const c = tr.clips.find(x => x.start <= t && t < clipEnd(x))
      if (c) return c
    }
  }
  for (const r of runs(f => f.diff < 0.002)) {
    // A frozen run counts only inside one moving-picture clip (stills and text never move).
    let i = r.from
    while (i <= r.to) {
      const clip = topVideo(frames[i].t)
      let j = i
      while (j + 1 <= r.to && topVideo(frames[j + 1].t) === clip) j++
      const s = frames[i].t, e = frames[j].t
      if (clip && mediaType(clip)?.timeBased && clip.type !== 'image' && e - s >= 2 * FLICKS)
        add({ rule: 'freeze', severity: 'warning', start: s, end: e, clipIds: [id(clip)],
          message: `${JSON.stringify(clip.name)} looks frozen ${clock(s)}–${clock(e)} (${sec(e - s)} s without picture change)`,
          suggestedFix: 'check its speed/source range (a held frame, a paused source); cut or replace the still stretch' })
      i = j + 1
    }
  }

  // ── cut rhythm (top track holding video) ──
  const videoTrack = [...visualTracks].reverse().find(t => t.clips.some(c => mediaType(c)?.timeBased))
  if (videoTrack) {
    const shots = [...videoTrack.clips].sort((a, b) => a.start - b.start)
    const lengths = shots.map(c => c.duration)
    const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)
    const tail = `average shot ${sec(avg)} s over ${shots.length} shots on ${videoTrack.name}`
    for (const c of shots) if (c.duration > 8 * FLICKS) add({ rule: 'cut-rhythm', severity: 'info', start: c.start, end: clipEnd(c), clipIds: [id(c)],
      message: `${JSON.stringify(c.name)} holds ${sec(c.duration)} s (${tail})`, suggestedFix: 'split it and cut away (b-roll, a punch-in keyframe) if the pace drags' })
    for (let i = 0; i < shots.length;) {
      let j = i
      while (j < shots.length && shots[j].duration < 0.4 * FLICKS) j++
      if (j - i >= 3) add({ rule: 'cut-rhythm', severity: 'info', start: shots[i].start, end: clipEnd(shots[j - 1]), clipIds: shots.slice(i, j).map(id),
        message: `${j - i} cuts under 0.4 s in a row ${clock(shots[i].start)}–${clock(clipEnd(shots[j - 1]))} (${tail})`, suggestedFix: 'intentional for a montage; otherwise lengthen some shots' })
      i = Math.max(j, i + 1)
    }
  }

  // ── repeated source ranges ──
  const placed = tl.tracks.flatMap(t => t.clips.filter(c => c.mediaId && mediaType(c)?.timeBased && (t.kind === 'visual' || !c.linkId)))
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j]
    if (a.mediaId !== b.mediaId || (a.linkId && a.linkId === b.linkId)) continue
    const sa = sourceSpan(a, app.edit.timeMap(a)), sb = sourceSpan(b, app.edit.timeMap(b))
    const lo = Math.max(sa.lo, sb.lo), hi = Math.min(sa.hi, sb.hi)
    if (hi - lo <= frameDuration(fps)) continue
    add({ rule: 'repeated-media', severity: 'info', start: Math.min(a.start, b.start), end: Math.max(clipEnd(a), clipEnd(b)), clipIds: [id(a), id(b)],
      message: `${JSON.stringify(a.name)} at ${clock(a.start)} and ${clock(b.start)} reuse the same ${sec(hi - lo)} s of source (${clock(lo)}–${clock(hi)})`,
      suggestedFix: 'fine for a callback or stutter; otherwise pick another source range' })
  }

  // ── gaps (nothing on any visible visual track) ──
  const spans = visualTracks.flatMap(t => t.clips.map(c => [c.start, clipEnd(c)] as const)).sort((a, b) => a[0] - b[0])
  let cursor = 0
  const minGap = frameDuration(fps)
  for (const [s, e] of spans) {
    if (s - cursor >= minGap && cursor < duration) add({ rule: 'gap', severity: 'warning', start: cursor, end: s, clipIds: [],
      message: `Nothing on screen ${clock(cursor)}–${clock(s)} (${sec(s - cursor)} s of black)`, suggestedFix: `ripple_delete ${clock(cursor)}–${clock(s)}, or fill it` })
    cursor = Math.max(cursor, e)
  }

  return issues.sort((a, b) => a.start - b.start || SEVERITY[a.severity] - SEVERITY[b.severity])
}

function clipsAt(tracks: Track[], s: Flicks, e: Flicks) {
  return tracks.flatMap(t => t.clips.filter(c => c.start < e && clipEnd(c) > s))
}
function short(text: string) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}
const fmt = (v: number) => Number.isFinite(v) ? v.toFixed(1) : '-inf'
