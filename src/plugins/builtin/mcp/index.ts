import { definePlugin } from '@core/plugin-api'
import { prepareExportRequest } from '../export-request'
import { CascadeApp, type CascadeAPI } from '@core/app'
import type { Session } from '../../../renderer/app/session'
import type { PluginHost } from '@core/plugin-host'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ExportProgress, McpCall } from '@shared/ipc'
import { snapToFrame, frameDuration, FLICKS, type Flicks } from '@shared/time'
import { clock } from './clock'
import { clipEnd, findClip, timelineDuration, type Clip, type Project } from '@shared/project'
import { defaultParams } from '@core/evaluate'
import { TIME_TEXT, tools } from '../../../main/mcp/catalog'
import { Ids, applyEdits, parseTimeText, resolveAnchor, staging, commit, validateValue } from './edits'
import { LoudnessMeter, formatDb } from './loudness'
import { BUILTIN_FONTS } from '../params/fonts'
import { projectTimelines, markerJson, markerText, transitionJson, transitionText, describeParams } from './inspection'
import { sourceSpan, clipTimeMap } from '@core/time-remap'
import { fontSpecimen, frame, imageResult } from './images'
import { renderSheets, loadImage, stats, change, type Cell, type SheetAudio } from './sheets'
import { lintTimeline, elementBox, LINT_RULES, TITLE_SAFE, type LintMeasurements } from './lint'
import { detectBeats, toMono } from './beats'
import { MAX_AUDIO_SECONDS, RATE, clipSource, decode, envelopeImage, renderMix, round1, show, summary } from './audio'
import { pluginDocs } from './plugin-docs'
import { captionClip } from '../captions/clip'
import type { CaptionsService } from '../captions'
import type { SourceAnalysis } from '@shared/analysis'
import { buildIndex, buildSourceIndex, findSpoken, formatTranscript, searchTranscript, SOURCE_LEGEND, type Analyses, type TIndex, type TWord, type TSentence } from './transcript'

interface CaptionJob { jobId: string; state: 'running' | 'done' | 'error'; phase: string; progress: number; message: string; clips?: number; report?: string; result?: CallToolResult }
type Filter = { trackId?: string; mediaId?: string; start?: Flicks; end?: Flicks; query?: string }

const TERMINAL = ['done', 'error', 'cancelled']
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const MUSIC = /music|sing|song|guitar|piano|drum|orchestra/i

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
/** Union of [start, end) spans, merged across gaps shorter than `gap`. */
function merge(spans: [Flicks, Flicks][], gap = 0): [Flicks, Flicks][] {
  const out: [Flicks, Flicks][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1)
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}
const covered = (spans: [Flicks, Flicks][], start: Flicks, end: Flicks) => spans.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0)
const pct = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 1000) / 10 : 0

export class AgentTools {
  readonly jobs = new Map<string, ExportProgress>()
  readonly captionJobs = new Map<string, CaptionJob>()
  readonly analyses: Analyses = new Map()
  readonly history: { label: string; source: string }[] = []
  /** Exports the agent started (the export panel's own jobs also land in `jobs`). */
  readonly agentExports = new Set<string>()
  /** Beat grids from beat_grid by source path (source flicks), for snap_to_beats. */
  readonly beatGrids = new Map<string, { beats: Flicks[]; downbeats: Flicks[] }>()
  /** timeline_apply_edits results by requestId, so a retried batch is not applied twice. */
  private readonly requests = new Map<string, string>()
  /** Bumped on every document change (UI or agent); ifRevision guards a batch against edits made meanwhile. */
  revision = 0
  constructor(readonly app: CascadeAPI, readonly ids = new Ids()) {}
  /** Flicks for a time argument: flicks, time text (00:01:23.500, 83.5s) or a transcript anchor. */
  private async time(value: number | string | undefined, fallback: number): Promise<number> {
    if (typeof value !== 'string') return value ?? fallback
    if (TIME_TEXT.test(value)) return parseTimeText(value, this.app.fps())
    return resolveAnchor(this.app.project(), await this.loadAnalyses(), this.ids, value, (c) => this.app.edit.timeMap(c))
  }
  /** Flicks for a plain time argument (source times): flicks or time text, no anchors. */
  private clockTime(value: number | string | undefined, fallback: number): number {
    return typeof value === 'string' ? parseTimeText(value, this.app.fps()) : value ?? fallback
  }
  /** Timeline range from start/end arguments, defaulting to the whole timeline. */
  private async range(a: Record<string, any>) {
    const start = await this.time(a.start, 0), end = Math.min(this.app.duration(), await this.time(a.end, this.app.duration()))
    if (end <= start) throw new Error(`Empty range ${clock(start)}–${clock(end)}; the timeline is ${clock(this.app.duration())} long`)
    return { start, end }
  }
  /** Text width in px for a CSS font string (lint and guides measure text boxes with it). */
  private canvas?: CanvasRenderingContext2D
  private measure = (value: string, font: string) => { this.canvas ??= document.createElement('canvas').getContext('2d')!; this.canvas.font = font; return this.canvas.measureText(value).width }
  /** Where the user is: playhead (+ playing) and selected clips, in agent ids. Empty without an open project. */
  editorState(): string {
    const app = this.app
    if ((this.app.services.get('session') as Session | undefined)?.screen() !== 'editor') return ''
    const t = app.playback.time.get(), clips = app.selection.clips.get().map(id => this.ids.show(id, 'c'))
    return `playhead ${clock(t)} (${t} flicks)${app.playback.playing.get() ? ', playing' : ''}${clips.length ? `; selected ${clips.join(', ')}` : '; nothing selected'}`
  }
  /** editorState plus every clip under the playhead, with clip-local and (time-based media) source time. */
  private playhead(): string {
    const app = this.app, ids = this.ids, t = app.playback.time.get(), tc = (v: Flicks) => clock(v)
    const lines = [this.editorState()]
    for (const tr of app.timeline().tracks) for (const c of tr.clips) {
      if (t < c.start || t >= clipEnd(c)) continue
      const local = t - c.start, media = c.mediaId ? app.project().media[c.mediaId] : undefined
      const source = media && app.registries.mediaTypes.get(c.type)?.timeBased ? ` | source ${media.path ? ids.show(media.id, 'm') : ''} ${tc(c.sourceIn + app.edit.timeMap(c).offset(local))}` : ''
      lines.push(`${ids.show(tr.id, 't')} ${tr.name}: ${ids.show(c.id, 'c')} ${c.type} ${JSON.stringify(c.name)} | clip-local ${tc(local)} (${local})${source}`)
    }
    if (lines.length === 1) lines.push('no clips under the playhead')
    return lines.join('\n')
  }
  /** The long-running job the agent is waiting on, for the agent panel's progress bar. */
  activeJob(): { label: string; message: string; progress?: number } | undefined {
    const LABELS: Record<string, string> = { analysis: 'Analyzing media', captions: 'Generating captions', audio: 'Measuring audio', inspect: 'Inspecting', lint: 'Checking the edit' }
    for (const j of this.captionJobs.values()) if (j.state === 'running')
      return { label: LABELS[j.jobId.replace(/-\d+$/, '')] ?? 'Working', message: j.message, progress: j.phase === 'download' || !j.progress ? undefined : j.progress }
    for (const id of this.agentExports) {
      const j = this.jobs.get(id)
      if (!j || TERMINAL.includes(j.state)) continue
      return { label: 'Exporting', message: j.framesTotal ? `${j.framesDone} / ${j.framesTotal} frames` : j.state, progress: j.framesTotal ? j.framesDone / j.framesTotal : undefined }
    }
  }
  private session() {
    const session = this.app.services.get('session') as Session | undefined
    if (!session) throw new Error('Editor session is still starting. Retry shortly.')
    return session
  }
  private projectRequired() { if (this.session().screen() !== 'editor') throw new Error('No project open. Use project_new(name) or project_open(path).') }
  private async path(value: string): Promise<string> {
    if (/^~[\\/]/.test(value)) return `${(await this.app.host!.info()).paths.home}/${value.slice(2)}`
    if (!value.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(value)) throw new Error('Use an absolute path (or ~/path)')
    return value
  }
  private busy() {
    if ([...this.captionJobs.values()].some(j => j.state === 'running') || [...this.agentExports].some(id => { const j = this.jobs.get(id); return j && !TERMINAL.includes(j.state) }))
      throw new Error('Another export/analysis job is running; wait for it with job_get')
  }
  /** Wait for an export this session started. */
  private async waitExport(jobId: string) {
    for (;;) {
      const p = this.jobs.get(jobId)
      if (p?.state === 'done') return
      if (p && TERMINAL.includes(p.state)) throw new Error(`Rendering failed: ${p.message ?? p.state}`)
      await sleep(200)
    }
  }
  /** Run `work` as a job; return its result if it finishes within `wait` seconds, else the jobId to poll. */
  private async job(kind: string, wait: number, work: (job: CaptionJob) => Promise<CallToolResult>): Promise<CallToolResult> {
    this.busy()
    const jobId = `${kind}-${this.captionJobs.size + 1}`
    const job: CaptionJob = { jobId, state: 'running', phase: 'starting', progress: 0, message: 'Starting' }
    this.captionJobs.set(jobId, job)
    const done = work(job).then(result => { Object.assign(job, { state: 'done', progress: 1, message: 'Done; the result follows', result }) })
      .catch(error => { Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    await Promise.race([done, sleep(wait * 1000)])
    if (job.state === 'done') return job.result!
    if (job.state === 'error') throw new Error(job.message)
    return text({ jobId, next: 'Still running; job_get with wait (e.g. wait=60) returns the result.' })
  }
  private renderMix(start: Flicks, end: Flicks) { return renderMix(this.app, start, end, id => this.waitExport(id)) }

  private clipFilter(filter: Filter) {
    const from = filter.start ?? 0, to = filter.end ?? Infinity, query = filter.query?.toLowerCase(), media = filter.mediaId && this.ids.resolve(filter.mediaId)
    return (c: Clip) => c.start < to && clipEnd(c) > from && (!media || c.mediaId === media) && (!query || c.name.toLowerCase().includes(query) || c.properties.some(p => p.type === 'text' && String(p.params.text?.value ?? '').toLowerCase().includes(query)))
  }
  /** One line per clip. Concise drops parameters at their defaults (and properties left entirely at defaults). */
  private timeline(detailed = false, filter: Filter = {}, tl = this.app.timeline()) {
    const app = this.app, ids = this.ids, tc = (t: Flicks) => clock(t)
    const lines = [`${tl.name} | id ${ids.show(tl.id, 'l')} | ${tl.id === app.project().activeTimeline ? 'active' : 'inactive'} | duration ${tc(timelineDuration(tl))} (${timelineDuration(tl)}) | revision ${this.revision} | times HH:MM:SS.mmm [flicks); 1s=${FLICKS} flicks`, `user: ${this.editorState()}`]
    const matches = this.clipFilter(filter), from = filter.start ?? 0, to = filter.end ?? Infinity
    const filtered = Object.values(filter).some(v => v !== undefined)
    let shown = 0
    for (const tr of tl.tracks) {
      if (filter.trackId && tr.id !== ids.resolve(filter.trackId)) continue
      const clips = tr.clips.filter(matches)
      if (filtered && !clips.length && !filter.trackId) continue
      lines.push(`${ids.show(tr.id, 't')} ${tr.name} [${tr.kind}${tr.locked ? ',locked' : ''}${tr.muted ? ',muted' : ''}${tr.hidden ? ',hidden' : ''}${tr.solo ? ',solo' : ''}${tr.gain ? `,gain=${tr.gain}dB` : ''}${tr.pan ? `,pan=${tr.pan}` : ''}]${filtered && clips.length < tr.clips.length ? ` (${clips.length} of ${tr.clips.length} clips match)` : ''}`)
      for (const c of clips) lines.push(`  ${ids.show(c.id, 'c')} ${tc(c.start)}–${tc(clipEnd(c))} [${c.start}, ${clipEnd(c)}) ${c.type} ${JSON.stringify(c.name)}${this.clipSource(c, tl)}${this.clipProperties(c, detailed)}`)
      for (const tx of tr.transitions ?? []) lines.push(`  ${transitionText(ids, tx)}`)
      for (const c of clips) for (const m of c.markers ?? []) lines.push(`  ${markerText(app, ids, tl, m, c)}`)
      shown += clips.length
    }
    if (filter.trackId && lines.length === 2) throw new Error(`Unknown track ${filter.trackId}`)
    if (filtered && !shown) lines.push('no clips match')
    for (const m of tl.markers) if (!filtered || (m.t >= from && m.t < to)) lines.push(markerText(app, ids, tl, m))
    return lines.join('\n')
  }
  /** The same as timeline(), as compact objects. */
  private timelineJson(detailed: boolean, filter: Filter, tl = this.app.timeline()) {
    const app = this.app, ids = this.ids, matches = this.clipFilter(filter)
    const filtered = Object.values(filter).some(v => v !== undefined)
    const tracks = tl.tracks.filter(tr => !filter.trackId || tr.id === ids.resolve(filter.trackId))
      .map(tr => ({ id: ids.show(tr.id, 't'), name: tr.name, kind: tr.kind, locked: tr.locked, muted: tr.muted, hidden: tr.hidden, ...(tr.solo ? { solo: true } : {}), ...(tr.gain ? { gain: tr.gain } : {}), ...(tr.pan ? { pan: tr.pan } : {}), transitions: (tr.transitions ?? []).map(tx => transitionJson(ids, tx)), clips: tr.clips.filter(matches).map(c => this.clipJson(c, detailed, tl)) }))
      .filter(t => !filtered || filter.trackId || t.clips.length)
    return { id: ids.show(tl.id, 'l'), active: tl.id === app.project().activeTimeline, name: tl.name, duration: clock(timelineDuration(tl)), durationFlicks: timelineDuration(tl), revision: this.revision, user: this.editorState(), tracks, markers: tl.markers.filter(m => m.t >= (filter.start ?? 0) && m.t < (filter.end ?? Infinity)).map(m => markerJson(app, ids, tl, m)) }
  }
  private clipJson(c: Clip, detailed: boolean, tl = this.app.timeline()) {
    const app = this.app, ids = this.ids
    const media = c.mediaId ? app.project().media[c.mediaId] : undefined
    const map = media && app.registries.mediaTypes.get(c.type)?.timeBased ? clipTimeMap(c, tl, app.registries) : undefined
    const span = map && sourceSpan(c, map)
    const linked = c.linkId ? tl.tracks.flatMap(t => t.clips.filter(x => x.id !== c.id && x.linkId === c.linkId)).map(x => ids.show(x.id, 'c')) : []
    const properties = c.properties.flatMap(p => {
      const contrib = app.registries.properties.get(p.type), defaults = contrib ? defaultParams(contrib) : {}
      const params = Object.entries(p.params).filter(([k, v]) => detailed || v.keyframes?.length || JSON.stringify(v.value) !== JSON.stringify(defaults[k]?.value))
      if (!detailed && !params.length && p.enabled) return []
      return [{ id: ids.show(p.id, 'p'), type: p.type, ...(p.enabled ? {} : { enabled: false }), params: Object.fromEntries(params.map(([k, v]) => [k, v.keyframes?.length ? { value: v.value, keyframes: v.keyframes.map(kf => ({ t: kf.t, value: kf.value, ...(kf.easing ? { easing: kf.easing.id } : {}) })) } : v.value])) }]
    })
    return {
      id: ids.show(c.id, 'c'), type: c.type, name: c.name, start: clock(c.start), end: clock(clipEnd(c)), startFlicks: c.start, endFlicks: clipEnd(c),
      ...(media ? { mediaId: ids.show(media.id, 'm') } : {}),
      ...(span ? { source: { in: clock(span.lo), out: clock(span.hi) } } : {}),
      ...(map && (map.constant !== 1 || map.reversed) ? { speed: map.constant ?? 'keyframed', ...(map.reversed ? { reversed: true } : {}) } : {}),
      ...(media?.timelineId ? { timelineId: ids.show(media.timelineId, 'l') } : {}),
      ...(linked.length ? { linked } : {}), transitions: tl.tracks.flatMap(tr => (tr.transitions ?? []).filter(tx => tx.from === c.id || tx.to === c.id).map(tx => transitionJson(ids, tx))), markers: (c.markers ?? []).map(m => markerJson(app, ids, tl, m, c)), properties
    }
  }
  /** One clip in full: every property value and keyframe (clip-local flicks). */
  private clipDetail(value: string, tl = this.app.timeline()) {
    const app = this.app, ids = this.ids, tc = (t: Flicks) => clock(t)
    const found = findClip(tl, ids.resolve(value))
    if (!found) throw new Error(`Unknown clip ${value}; refresh timeline_get`)
    const { clip: c, track } = found
    const lines = [`${ids.show(c.id, 'c')} on ${ids.show(track.id, 't')} ${track.name} | ${tc(c.start)}–${tc(clipEnd(c))} [${c.start}, ${clipEnd(c)}) ${c.type} ${JSON.stringify(c.name)}${this.clipSource(c, tl)} | revision ${this.revision}`]
    for (const p of c.properties) {
      lines.push(`${ids.show(p.id, 'p')}:${p.type}${p.enabled ? '' : ' (off)'}`)
      for (const [k, v] of Object.entries(p.params)) lines.push(`  ${k} = ${JSON.stringify(v.value)}${v.keyframes?.length ? ` keyframes ${v.keyframes.map(kf => `${kf.t}:${JSON.stringify(kf.value)}${kf.easing ? `(${kf.easing.id})` : ''}`).join(' ')}` : ''}`)
    }
    for (const m of c.markers ?? []) lines.push(markerText(app, ids, tl, m, c))
    for (const tx of track.transitions ?? []) if (tx.from === c.id || tx.to === c.id) lines.push(transitionText(ids, tx))
    return lines.join('\n')
  }
  /** Source, speed and link of a clip: ` m1 src 00:10:00.000–00:10:02.000 speed 2× reversed linked=c4`. */
  private clipSource(c: Clip, tl = this.app.timeline()) {
    const app = this.app, ids = this.ids
    const media = c.mediaId ? app.project().media[c.mediaId] : undefined
    let out = ''
    if (media?.timelineId) out += ` timeline=${ids.show(media.timelineId, 'l')}`
    if (media?.path) out += ` ${ids.show(media.id, 'm')}`
    if (media && app.registries.mediaTypes.get(c.type)?.timeBased) {
      const map = clipTimeMap(c, tl, app.registries), { lo, hi } = sourceSpan(c, map)
      out += ` src ${clock(lo)}–${clock(hi)}`
      const speed = map.constant === null ? `speed keyframed ${+map.min.toFixed(2)}–${+map.max.toFixed(2)}×` : map.constant !== 1 ? `speed ${+map.constant.toFixed(3)}×` : ''
      const remap = app.registries.properties.all().find(p => p.timeRemap)?.id
      const own = c.properties.some(p => p.type === remap && p.enabled)
      if (speed || map.reversed) out += ` ${[speed, map.reversed ? 'reversed' : ''].filter(Boolean).join(' ')}${own || !c.linkId ? '' : ' (from linked clip)'}`
    }
    if (c.linkId) {
      const partners = tl.tracks.flatMap(t => t.clips.filter(x => x.id !== c.id && x.linkId === c.linkId))
      if (partners.length) out += ` linked=${partners.map(x => ids.show(x.id, 'c')).join(',')}`
    }
    return out
  }
  private clipProperties(c: Clip, detailed: boolean) {
    const ids = this.ids
    const parts = c.properties.flatMap(p => {
      const contrib = this.app.registries.properties.get(p.type)
      const defaults = contrib ? defaultParams(contrib) : {}
      const params = Object.entries(p.params).filter(([k, v]) => detailed || v.keyframes?.length || JSON.stringify(v.value) !== JSON.stringify(defaults[k]?.value))
      if (!detailed && !params.length && p.enabled) return []
      return [`${ids.show(p.id, 'p')}:${p.type}${p.enabled ? '' : '(off)'}{${params.map(([k, v]) => `${k}=${JSON.stringify(v.value)}${v.keyframes?.length ? ` [${v.keyframes.length} keys]` : ''}`).join(',')}}`]
    })
    return parts.length ? ` | ${parts.join(' ')}` : ''
  }
  /** Font families accepted by font params: bundled, generic and installed. */
  private async fonts() {
    return [...BUILTIN_FONTS, ...(await this.app.host?.fonts().catch(() => []) ?? [])]
  }
  /** Visible clips at t, top first. */
  private visibleAt(t: Flicks) {
    return this.app.timeline().tracks.filter(tr => tr.kind === 'visual' && !tr.hidden).flatMap(tr => tr.clips.filter(c => c.start <= t && t < clipEnd(c))).reverse()
  }
  /** What a timeline sheet cell shows besides the picture: visible clips (top first), audio, the words around it, and text problems. */
  private cellInfo(index: TIndex, t: Flicks) {
    const ids = this.ids, tracks = this.app.timeline().tracks
    const visible = this.visibleAt(t)
    const audible = tracks.filter(tr => tr.kind === 'audio' && !tr.muted).flatMap(tr => tr.clips.filter(c => c.start <= t && t < clipEnd(c)))
    const short = (c: Clip) => c.name.length > 40 ? `${c.name.slice(0, 40)}…` : c.name
    const name = (c: Clip) => `${ids.show(c.id, 'c')} ${JSON.stringify(short(c))}`
    const parts = [visible.length ? `shows ${visible.map(name).join(' over ')}` : 'nothing visible']
    if (audible.length) parts.push(`audio ${audible.map(name).join(', ')}`)
    // Words within ±1.5 s, the one being spoken at t in «»; a gap means silence or a pause there.
    const words = index.words.filter(w => w.end > t - 1.5 * FLICKS && w.start < t + 1.5 * FLICKS)
    const said = words.map(w => w.start <= t && t < w.end ? `«${w.text}»` : w.text).join(' ')
    if (words.length) parts.push(`says "${said}"`)
    const issues = lintTimeline(this.app, { start: t, end: t + 1 }, { measureText: this.measure }, { rules: ['text-overflow', 'safe-area', 'text-overlap'] })
    return {
      note: parts.join('; '),
      data: { clips: visible.map(c => ({ id: ids.show(c.id, 'c'), name: short(c), type: c.type })), audio: audible.map(c => ids.show(c.id, 'c')), ...(words.length ? { words: said } : {}) },
      flags: [...new Set(issues.map(i => i.rule === 'text-overflow' ? 'text-overflow' : i.rule === 'safe-area' ? 'outside-safe-area' : 'text-overlap'))]
    }
  }
  /** Pull cached analyses for every file-backed source (cheap; nothing is computed). */
  private async loadAnalyses(): Promise<Analyses> {
    const bridge = this.app.host?.analysis
    if (!bridge) return this.analyses
    const paths = [...new Set(Object.values(this.app.project().media).map(m => m.path).filter((p): p is string => !!p))]
    await Promise.all(paths.map(async path => { this.analyses.set(path, await bridge.cached(path)) }))
    return this.analyses
  }
  private async index() { return buildIndex(this.app.project(), await this.loadAnalyses(), (c) => this.app.edit.timeMap(c)) }
  private transcriptIds() {
    const ids = this.ids
    return { wordId: (w: TWord) => ids.show(w.key, 'w'), sentenceId: (s: TSentence) => ids.show(s.key, 's'), clipLabel: (c: { id: string }) => ids.show(c.id, 'c'), trackLabel: (t: { id: string; name: string }) => `${ids.show(t.id, 't')} ${t.name}` }
  }
  /** A file-backed source by agent id, with its visual check. */
  private media(value: string, visual = false) {
    const m = this.app.project().media[this.ids.resolve(value)]
    if (!m?.path) throw new Error(`${value} is not a file-backed source from media_list`)
    if (visual && !m.meta.hasVideo && m.type !== 'image') throw new Error(`${value} has no picture`)
    return m
  }
  /** Shot boundaries in [start, end): analysis cuts plus (timeline) edges of picture clips; text and element clips are overlays, not shots. */
  private cuts(index: TIndex, start: Flicks, end: Flicks, timeline: boolean) {
    const edges = timeline ? this.app.timeline().tracks.filter(t => t.kind === 'visual' && !t.hidden).flatMap(t => t.clips.filter(c => this.app.registries.mediaTypes.get(c.type)?.timeBased || c.type === 'image').flatMap(c => [c.start, clipEnd(c)])) : []
    const all = [...new Set([start, ...[...index.shots.map(s => s.t), ...edges].filter(t => t > start && t < end)])].sort((a, b) => a - b)
    // Drop cuts closer than two frames (a clip edge next to the analysis cut of the same shot change).
    const min = 2 * frameDuration(this.app.fps())
    return all.filter((t, i) => i === 0 || t - all[i - 1] >= min).map((t, i, list): [Flicks, Flicks] => [t, list[i + 1] ?? end])
  }

  async call(call: McpCall): Promise<CallToolResult> {
    try {
      const def = tools.find(t => t.name === call.tool)
      if (!def) throw new Error(`Unknown tool ${call.tool}`)
      const a = def.schema.parse(call.args) as Record<string, any>
      const app = this.app, host = app.host!, ids = this.ids
      if (!['project_new', 'project_open', 'registry_list', 'font_preview', 'plugin_api_docs', 'plugin_list', 'plugin_write', 'plugin_remove'].includes(call.tool)) this.projectRequired()
      switch (call.tool) {
        case 'project_get': return text(a.detail === 'detailed' ? { ...app.project(), timelineSummaries: projectTimelines(app, ids) } : { timelines: projectTimelines(app, ids), name: app.project().name, path: this.session().path(), revision: this.revision, settings: app.project().settings, duration: clock(app.duration()), durationFlicks: app.duration(), editor: this.editorState(), media: app.project().mediaOrder.length, tracks: app.timeline().tracks.map(t => ({ id: ids.show(t.id, 't'), name: t.name, kind: t.kind, locked: t.locked, muted: t.muted, hidden: t.hidden, clips: t.clips.length })) })
        case 'project_new': await this.session().newProject(a.name, a.settings ?? {}); return text(`Created ${app.project().name}; it is written to ${this.session().path()} on the first edit (autosave) or project_save`)
        case 'project_open': {
          const path = await this.path(a.path)
          // Session.open reports failures to the UI; preflight so MCP gets an actionable failure too.
          const before = app.project()
          await this.session().open(path)
          if (app.project() === before || this.session().path() !== path) throw new Error(`Could not open ${path}; inspect the file format and editor notification`)
          return text(`Opened ${app.project().name}`)
        }
        case 'project_save': if (!this.session().path()) throw new Error('Project has no save path; use project_new or project_open'); if (!await this.session().save()) throw new Error('Save failed; inspect the output path permissions'); return text(`Saved ${this.session().path()}`)
        case 'project_settings_set': { const copy = staging(app); copy.edit.setProjectSettings(a.settings); commit(app, copy.project(), 'project settings'); return text(app.project().settings) }
        case 'media_list': return text(app.project().mediaOrder.map(id => { const m = app.project().media[id]; return a.detail === 'detailed' ? { ...m, shortId: ids.show(id, 'm') } : { id: ids.show(id, 'm'), type: m.type, name: m.name, duration: m.meta.duration === undefined ? undefined : clock(m.meta.duration), path: m.path } }))
        case 'media_relink': {
          const mediaId = ids.resolve(a.mediaId), path = await this.path(a.path)
          if (!app.project().media[mediaId]) throw new Error(`Unknown media ${a.mediaId}`)
          // Probe through the normal editing API on an isolated host-backed copy.
          const before = app.project()
          let probeError = ''
          const copy = new CascadeApp('editor', { ...host, media: { ...host.media, probe: async p => {
            const probe = await host.media.probe(p)
            probeError = probe.error ?? ''
            return probe
          } } }, structuredClone(before))
          Object.assign(copy.registries, app.registries)
          if (!await copy.edit.relinkMedia(mediaId, path)) throw new Error(probeError || `Could not relink ${a.mediaId}`)
          if (app.project() !== before) throw new Error('Project changed during relink. Retry the relink.')
          commit(app, copy.project(), 'relink media')
          const media = app.project().media[mediaId]
          return text({ id: ids.show(mediaId, 'm'), path: media.path, ...media.meta, ...(media.meta.duration !== undefined ? { duration: clock(media.meta.duration), durationFlicks: media.meta.duration } : {}) })
        }
        case 'media_probe': return text(await host.media.probe(await this.path(a.path)))
        case 'media_import': {
          // Probe asynchronously in isolation; refuse to overwrite UI changes made while importing.
          const before = app.project(), copy = staging(app)
          const paths = await Promise.all((a.paths as string[]).map(p => this.path(p)))
          const media: { path: string; meta: Awaited<ReturnType<typeof host.media.probe>> }[] = []
          for (const path of paths) {
            const meta = await host.media.probe(path)
            if (meta.error) throw new Error(`${path}: ${meta.error}`)
            const mt = copy.edit.mediaTypeFor({ path, name: path.split(/[\\/]/).pop()!, ext: path.split('.').pop()!.toLowerCase(), meta })
            if (!mt) throw new Error(`Unsupported media ${path}`)
            media.push({ path, meta })
          }
          // Use the normal import operation with a host that reuses the successful probes.
          const importer = new CascadeApp('editor', { ...host, media: { ...host.media, probe: async p => media.find(m => m.path === p)!.meta } }, copy.project())
          Object.assign(importer.registries, app.registries)
          const imported = await importer.edit.importFiles(paths)
          if (app.project() !== before) throw new Error('Project changed during import. Retry the import.')
          commit(app, importer.project(), `import ${imported.length} media`)
          return text(imported.map(id => ({ id: ids.show(id, 'm'), name: app.project().media[id].name })))
        }
        case 'timeline_switch': {
          const id = ids.resolve(a.timelineId)
          if (!app.project().timelines[id]) throw new Error(`Unknown timeline ${a.timelineId}; refresh project_get`)
          app.edit.setActiveTimeline(id)
          return text({ timelineId: ids.show(id, 'l'), name: app.timeline().name, editor: this.editorState() })
        }
        case 'timeline_get': {
          const tl = a.timelineId ? app.project().timelines[ids.resolve(a.timelineId)] : app.timeline()
          if (!tl) throw new Error(`Unknown timeline ${a.timelineId}; refresh project_get`)
          if (a.clipId) return a.format === 'json' ? text(this.clipJson(findClip(tl, ids.resolve(a.clipId))?.clip ?? (() => { throw new Error(`Unknown clip ${a.clipId}; refresh timeline_get`) })(), true, tl)) : text(this.clipDetail(a.clipId, tl))
          const project = { ...app.project(), activeTimeline: tl.id }
          const time = async (value: number | string | undefined) => typeof value === 'string'
            ? resolveAnchor(project, await this.loadAnalyses(), ids, value, c => clipTimeMap(c, tl, app.registries)) : value
          const filter: Filter = { trackId: a.trackId, mediaId: a.mediaId, query: a.query, start: await time(a.start), end: await time(a.end) }
          if (filter.trackId && !tl.tracks.some(tr => tr.id === ids.resolve(filter.trackId!))) throw new Error(`Unknown track ${filter.trackId}`)
          if (a.format === 'json') return text(this.timelineJson(a.detail === 'detailed', filter, tl))
          const index = buildIndex(project, await this.loadAnalyses(), c => clipTimeMap(c, tl, app.registries))
          const hint = index.words.length ? `transcript: ${index.words.length} words, ${index.events.length} sound events, ${index.shots.length} shot cuts on the timeline; read with transcript_get`
            : index.unanalyzed.length ? `transcript: none; media_analyze ${[...new Set(index.unanalyzed.map(u => ids.show(u.clip.mediaId!, 'm')))].join(', ')} to edit by words, intonation, sound events and shots` : ''
          const body = this.timeline(a.detail === 'detailed', filter, tl)
          return text(hint ? `${body}\n${hint}` : body)
        }
        case 'playhead_get': return text(this.playhead())
        case 'playhead_set': {
          if (a.time === undefined && a.play === undefined) throw new Error('Give time and/or play')
          if (a.time !== undefined) app.playback.seek(snapToFrame(await this.time(a.time, 0), app.fps()))
          if (a.play === true) app.playback.play()
          if (a.play === false) app.playback.pause()
          return text(this.playhead())
        }
        case 'timeline_apply_edits': {
          if (a.requestId && this.requests.has(a.requestId)) return text(`Already applied (requestId ${a.requestId}); nothing applied again. Earlier result:\n${this.requests.get(a.requestId)}`)
          if (a.ifRevision !== undefined && a.ifRevision !== this.revision) throw new Error(`The project changed since revision ${a.ifRevision} (now ${this.revision}; see history_list). Nothing applied; re-read timeline_get and retry`)
          const result = `${applyEdits(app, a, ids, await this.loadAnalyses(), { fonts: await this.fonts(), dryRun: a.dryRun, beats: this.beatGrids })}\nrevision ${this.revision}`
          if (a.requestId && !a.dryRun) {
            this.requests.set(a.requestId, result)
            if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value!)
          }
          return text(result)
        }
        case 'history_undo': case 'history_redo': {
          const undo = call.tool === 'history_undo'
          let n = 0
          while (n < a.steps && (undo ? app.doc.undo() : app.doc.redo())) n++
          const next = undo ? (app.doc.canUndo ? `next undo: ${app.doc.undoLabel}` : 'nothing more to undo') : (app.doc.canRedo ? `next redo: ${app.doc.redoLabel}` : 'nothing more to redo')
          return text(n ? `${undo ? 'Undid' : 'Redid'} ${n} step${n > 1 ? 's' : ''}; revision ${this.revision}; ${next}` : `Nothing to ${undo ? 'undo' : 'redo'}`)
        }
        case 'history_list': return text({ revision: this.revision, canUndo: app.doc.canUndo, undo: app.doc.undoLabel, canRedo: app.doc.canRedo, redo: app.doc.redoLabel, recentEvents: this.history.slice(-30) })
        case 'registry_list': {
          const r = app.registries
          const fonts = (await this.fonts()).filter(f => !a.fontQuery || f.toLowerCase().includes(a.fontQuery.toLowerCase()))
          const sections: Record<string, () => unknown> = {
            mediaTypes: () => r.mediaTypes.all().map(({ id, name, track, extensions, defaultProperties }) => ({ id, name, track, extensions, defaultProperties })),
            properties: () => r.properties.all().map(({ id, name, description, params, appliesTo, stackable }) => ({ id, name, description, params: describeParams(params), appliesTo: Array.isArray(appliesTo) ? appliesTo : 'predicate/default; validated when adding', stackable })),
            easings: () => r.easings.all().map(({ id, name, params }) => ({ id, name, params })),
            generators: () => r.generators.all().map(({ id, name, mediaType }) => ({ id, name, mediaType })),
            exporters: () => r.exporters.all().map(({ id, name, extension, options }) => ({ id, name, extension, options })),
            transitions: () => r.transitions.all().map(({ id, name, kinds, params }) => ({ id, name, kinds, params: describeParams(params) })),
            markerKinds: () => r.markerKinds.all().map(({ id, name, color, icon }) => ({ id, name, color, icon })),
            presets: () => r.presets.all().map(({ id, kind, name, group }) => ({ id, kind, name, group })),
            timelineTools: () => r.timelineTools.all().map(({ id, name, key }) => ({ id, name, key })),
            fonts: () => fonts
          }
          return text(Object.fromEntries(((a.only ?? Object.keys(sections)) as string[]).map(k => [k, sections[k]()])))
        }
        case 'font_preview': {
          const all = await this.fonts()
          const families = a.families ?? all.filter(f => !a.query || f.toLowerCase().includes(a.query.toLowerCase()))
          if (!families.length) throw new Error(a.query ? `No installed font matches "${a.query}"; registry_list only=["fonts"] lists them` : 'Give families or query')
          const unknown = (a.families as string[] | undefined)?.filter(f => !all.some(x => x.toLowerCase() === f.toLowerCase())) ?? []
          const shown = families.slice(0, 24)
          const result = await fontSpecimen(shown, a.text ?? 'The quick brown fox jumps over the lazy dog 0123456789', a.weight)
          const notes = [`${shown.length} fonts, top to bottom: ${shown.join(', ')}`]
          if (families.length > shown.length) notes.push(`${families.length - shown.length} more match; narrow the query`)
          if (unknown.length) notes.push(`Not installed (shown in a fallback face): ${unknown.join(', ')}`)
          return imageResult(result, notes.join('\n'))
        }
        case 'frame_get': {
          const t = await this.time(a.time, 0)
          const url = await frame(app, t, a.width)
          const label = `${typeof a.time === 'string' ? `${a.time} = ` : ''}${clock(t)}`
          if (!a.guides) return imageResult(url, label)
          const { image, boxes } = await this.guides(url, t)
          return imageResult(image, `${label}\nGuides: dashed white = action safe (95%), dashed blue = title safe (${TITLE_SAFE * 100}%), orange = element boxes.\n${boxes.length ? boxes.join('\n') : 'No element boxes at this time.'}`)
        }
        case 'contact_sheet': return await this.contactSheet(a)
        case 'shot_list': return await this.shotList(a)
        case 'plugin_api_docs': return text(pluginDocs)
        case 'plugin_list': { const ph = app.services.get('plugins') as PluginHost; return text({ files: await host.plugins.list(), loaded: ph?.list().map(p => ({ id: p.def.id, source: p.source, active: p.active, error: p.error })) }) }
        case 'plugin_write': return await this.writePlugin(a.name, a.code)
        case 'plugin_remove': await host.plugins.remove(a.name); return text(`Removed ${a.name}; hot unload requested`)
        case 'export_start': {
          if (!app.registries.exporters.get(a.exporter)) throw new Error('Unknown exporter; inspect registry_list')
          const start = this.clockTime(a.start, 0), end = this.clockTime(a.end, app.duration())
          if (end <= start || end > app.duration()) throw new Error('Export needs a nonempty range within the timeline')
          const jobId = await host.export.start(await prepareExportRequest(app, { exporter: a.exporter, output: await this.path(a.output), options: a.options, width: a.width, height: a.height, range: { start, end } }))
          if (!this.jobs.has(jobId)) this.jobs.set(jobId, { jobId, state: 'preparing', framesDone: 0, framesTotal: 0, fps: 0 })
          this.agentExports.add(jobId)
          return text({ jobId, next: 'Poll job_get' })
        }
        case 'job_get': {
          const job = () => this.jobs.get(a.jobId) ?? this.captionJobs.get(a.jobId)
          if (!job()) throw new Error('Unknown job; use a jobId from export_start, media_analyze, captions_generate, audio_analyze or inspect_range in this editor session')
          const until = Date.now() + a.wait * 1000
          while (Date.now() < until && !TERMINAL.includes(job()!.state)) await sleep(250)
          const { report, result, ...rest } = job() as CaptionJob
          if (result) return { content: [{ type: 'text', text: JSON.stringify(rest) }, ...result.content] }
          return text(report ? `${JSON.stringify(rest, null, 2)}\n\n${report}` : rest)
        }
        case 'export_cancel': if (!this.jobs.has(a.jobId)) throw new Error('Unknown job'); await host.export.cancel(a.jobId); return text('Cancellation requested')
        case 'media_analyze': {
          const bridge = host.analysis
          if (!bridge) throw new Error('The analysis service is not available in this build')
          const media = this.media(a.mediaId)
          if (!(media.type === 'video' || media.type === 'audio')) throw new Error('Pick a video or audio source from media_list')
          if (media.meta.hasAudio === false) throw new Error('Source has no audio track')
          const start = a.start === undefined ? undefined : this.clockTime(a.start, 0), end = a.end === undefined ? undefined : this.clockTime(a.end, 0)
          const range = start !== undefined || end !== undefined ? { start: start ?? 0, end: end ?? media.meta.duration! } : undefined
          if (range && !(range.end > range.start)) throw new Error('end must be after start (source time)')
          if ([...this.captionJobs.values()].some(j => j.state === 'running')) throw new Error('An analysis/captions job is already running; poll job_get')
          const jobId = `analysis-${this.captionJobs.size + 1}`
          const job: CaptionJob = { jobId, state: 'running', phase: 'starting', progress: 0, message: 'Starting' }
          this.captionJobs.set(jobId, job)
          const off = bridge.onProgress(p => { if (job.state === 'running' && p.path === media.path) Object.assign(job, { phase: p.part, progress: Math.round(p.progress * 100) / 100, message: p.message }) })
          const run = async () => {
            const status = await bridge.status()
            if (status.missing.length) {
              const total = status.missing.reduce((n, m) => n + m.sizeBytes, 0)
              Object.assign(job, { phase: 'download', message: 'Waiting for the user to approve the model download in the editor' })
              const answer = await host.dialog.confirm({ message: 'Download local analysis models?', detail: `${Math.ceil(total / 1e6)} MB for ${[...new Set(status.missing.map(m => m.part))].join(', ')}. Everything runs on this computer.`, buttons: ['Download models', 'Skip'] })
              if (answer === 0) await bridge.installModels()
            }
            return bridge.run(media.path!, { range, language: a.language })
          }
          run().then((result: SourceAnalysis) => {
            const list = (this.analyses.get(media.path!) ?? []).filter(x => x.range.start !== result.range.start || x.range.end !== result.range.end)
            this.analyses.set(media.path!, [...list, result])
            Object.assign(job, { state: 'done', progress: 1, message: `Analyzed ${result.words.length} words, ${result.sentences.length} sentences, ${result.events.length} sound events, ${result.shots.length} shot cuts (parts: ${result.parts.join(', ')}). Next: transcript_get (on the timeline), or transcript_get mediaId=${ids.show(media.id, 'm')} to read the source and cut by source anchors.` })
          }).catch(error => Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) })).finally(off)
          return text({ jobId, next: 'Poll job_get (about 2s per minute of speech), then transcript_get.' })
        }
        case 'transcript_get': {
          const start = a.start === undefined ? undefined : this.clockTime(a.start, 0), end = a.end === undefined ? undefined : this.clockTime(a.end, 0)
          const page = { view: a.view, start, end, maxLines: a.maxLines, offset: a.offset, fps: app.fps() }
          if (a.mediaId) {
            const { index, names } = await this.sourceTranscript(a.mediaId)
            return text(formatTranscript(index, { legend: SOURCE_LEGEND, ...page, ...names }))
          }
          return text(formatTranscript(await this.index(), { ...page, clipId: a.clipId && ids.resolve(a.clipId), ...this.transcriptIds() }))
        }
        case 'transcript_search': {
          const source = a.mediaId ? await this.sourceTranscript(a.mediaId) : undefined
          const index: TIndex = source?.index ?? await this.index()
          const lo = this.clockTime(a.start, 0), hi = this.clockTime(a.end, Number.MAX_SAFE_INTEGER)
          const hits = searchTranscript(index, a.query, a.regex, a.any).filter(h => h.sentence.words[h.to].end > lo && h.sentence.words[h.from].start < hi)
          const t = source?.names ?? this.transcriptIds()
          if (!hits.length) return text(index.words.length ? 'No matches.' : 'No transcript yet. Run media_analyze on the sources first.')
          const page = hits.slice(a.offset, a.offset + a.limit)
          const lines = page.map(h => { const w = h.sentence.words; return `${t.sentenceId(h.sentence)} ${t.wordId(w[h.from])}${h.to > h.from ? `–${t.wordId(w[h.to])}` : ''} ${clock(w[h.from].start)}–${clock(w[h.to].end)} ${w.map((x, i) => `${i === h.from ? '«' : ''}${x.text}${i === h.to ? '»' : ''}`).join(' ')}` })
          const rest = hits.length - a.offset - page.length
          return text([`${hits.length} matches${a.offset ? `, from ${a.offset + 1}` : ''}`, ...lines, ...(rest > 0 ? [`… ${rest} more; continue with offset=${a.offset + page.length}`] : [])].join('\n'))
        }
        case 'audio_analyze': return await this.audioAnalyze(a)
        case 'audio_normalize': return await this.audioNormalize(a)
        case 'silence_trim': return await this.silenceTrim(a)
        case 'beat_grid': return await this.beatGrid(a)
        case 'timeline_lint': {
          const { start, end } = await this.range(a)
          return await this.job('lint', 120, async job => {
            const { issues, checked } = await this.lint(start, end, { audio: a.audio, frames: a.frames, rules: a.rules }, job)
            return text({ range: `${clock(start)}–${clock(end)}`, checked, counts: { error: issues.filter(i => i.severity === 'error').length, warning: issues.filter(i => i.severity === 'warning').length, info: issues.filter(i => i.severity === 'info').length }, issues })
          })
        }
        case 'timeline_stats': {
          const current = this.stats(app)
          if (!a.compareTo) return text(current)
          const other = JSON.parse(await host.fs.readText(await this.path(a.compareTo))) as Project
          const copy = new CascadeApp('editor', null, other)
          Object.assign(copy.registries, app.registries)
          const theirs: Record<string, unknown> = this.stats(copy)
          const delta = Object.fromEntries(Object.entries(current).flatMap(([k, v]) => typeof v === 'number' && typeof theirs[k] === 'number' ? [[k, Math.round((v - (theirs[k] as number)) * 100) / 100]] : []))
          return text({ current, [a.compareTo]: theirs, delta: { note: 'current minus compared', ...delta } })
        }
        case 'inspect_range': return await this.inspect(a)
        case 'captions_generate': return await this.captions(a)
        case 'captions_from_script': return await this.captionsFromScript(a)
      }
      throw new Error('Tool not implemented')
    } catch (error) { return { isError: true, content: [{ type: 'text', text: `${error instanceof Error ? error.message : String(error)}\nRecovery: inspect project_get, timeline_get or registry_list, correct the arguments, then retry.` }] } }
  }

  /** A source's transcript (source time) with source-anchor ids m1:w12 / m1:s3. */
  private async sourceTranscript(value: string) {
    const media = this.media(value)
    await this.loadAnalyses()
    const index = buildSourceIndex(media.id, this.analyses.get(media.path!))
    if (!index.words.length && !index.shots.length && !index.events.length) throw new Error(`No analysis for ${value}; run media_analyze first`)
    const alias = this.ids.show(media.id, 'm')
    const names = { wordId: (w: TWord) => `${alias}:w${index.wordNo.get(w)}`, sentenceId: (s: TSentence) => `${alias}:s${index.sentenceNo.get(s)}`, clipLabel: () => '', trackLabel: () => '' }
    return { index, names }
  }

  /** The frame with safe areas and element boxes drawn over it. */
  private async guides(url: string, t: Flicks) {
    const img = await loadImage(url)
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    const ctx = c.getContext('2d')!, W = c.width, H = c.height
    ctx.drawImage(img, 0, 0)
    ctx.lineWidth = Math.max(1, W / 640)
    for (const [f, color] of [[0.95, '#ffffffaa'], [TITLE_SAFE, '#82cbffdd']] as const) {
      ctx.setLineDash([8, 6]); ctx.strokeStyle = color
      ctx.strokeRect((1 - f) / 2 * W, (1 - f) / 2 * H, f * W, f * H)
    }
    ctx.setLineDash([])
    const boxes: string[] = []
    ctx.font = `${Math.max(12, Math.round(W / 60))}px Inter, sans-serif`
    for (const clip of this.visibleAt(t).reverse()) {
      const b = elementBox(this.app, clip, t, this.measure)
      if (!b) continue
      const id = this.ids.show(clip.id, 'c')
      ctx.strokeStyle = '#ffb86b'; ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H)
      ctx.fillStyle = '#ffb86b'; ctx.fillText(id, b.x * W + 4, b.y * H + Math.max(12, W / 60) + 2)
      const r = (v: number) => Math.round(v * 1000) / 1000
      boxes.push(`${id} ${JSON.stringify(clip.name.slice(0, 40))}: x ${r(b.x)} y ${r(b.y)} w ${r(b.w)} h ${r(b.h)} (frame fractions, top-left origin)`)
    }
    return { image: c.toDataURL('image/png'), boxes }
  }

  private async contactSheet(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids
    const media = a.mediaId ? this.media(a.mediaId, true) : undefined
    const total = media ? media.meta.duration ?? FLICKS : app.duration()
    const start = media ? this.clockTime(a.start, 0) : await this.time(a.start, 0)
    const end = Math.min(total, media ? this.clockTime(a.end, total) : await this.time(a.end, total))
    if (end <= start) throw new Error(`Empty range ${clock(start)}–${clock(end)} (${media ? 'source' : 'timeline'} is ${clock(total)})`)
    const span = end - start
    const index = media ? buildSourceIndex(media.id, (await this.loadAnalyses()).get(media.path!)) : await this.index()
    let cells: Cell[], footer: string | undefined
    if (a.mode === 'even') {
      if ([a.count, a.interval, a.fps].filter(v => v !== undefined).length > 1) throw new Error('Give one of count, interval or fps')
      const step = a.interval !== undefined ? this.clockTime(a.interval, 0) : a.fps ? FLICKS / a.fps : span / (a.count ?? 9)
      const n = Math.max(1, Math.ceil(span / step - 1e-6))
      if (n > 200) throw new Error(`That is ${n} cells; at most 200 per call. Use a longer interval or lower fps, or narrow the range (e.g. end=${clock(start + 200 * step)})`)
      cells = Array.from({ length: n }, (_, i) => ({ t: Math.round(start + i * step), end: Math.min(end, Math.round(start + (i + 1) * step)) }))
    } else {
      const shots = this.cuts(index, start, end, !media)
      if (media && shots.length < 2 && !index.shots.length) throw new Error(`No shot cuts for ${a.mediaId}; run media_analyze first (or use mode=even)`)
      if (a.mode === 'shots') {
        const max = a.count ?? 30
        cells = shots.slice(0, max).map(([s, e]) => ({ t: Math.round((s + e) / 2), end: e, label: `${clock(s)}–${clock(e)}` }))
        footer = shots.length > max ? `${shots.length - max} more shots; continue with start=${clock(shots[max][0])}` : `${shots.length} shots in range`
      } else {
        // Smart: the first frame after each cut and each shot's middle, plus an even baseline; nearby picks merge (cuts win).
        const limit = a.count ?? 24, one = frameDuration(app.fps())
        const picks: { t: Flicks; kind: string; rank: number }[] = []
        for (const [i, [s, e]] of shots.entries()) {
          if (i > 0) picks.push({ t: Math.min(e - 1, s + one), kind: 'cut', rank: 0 })
          picks.push({ t: Math.round((s + e) / 2), kind: 'mid-shot', rank: 1 })
        }
        for (let i = 0; i < 12; i++) picks.push({ t: Math.round(start + span * i / 12), kind: '', rank: 2 })
        const kept: typeof picks = []
        for (const p of picks.sort((x, y) => x.rank - y.rank)) if (!kept.some(k => Math.abs(k.t - p.t) < Math.min(0.4 * FLICKS, span / (limit * 2)))) kept.push(p)
        kept.sort((x, y) => x.t - y.t)
        const chosen = kept.length > limit ? Array.from({ length: limit }, (_, i) => kept[Math.round(i * (kept.length - 1) / Math.max(1, limit - 1))]) : kept
        cells = chosen.map((p, i) => ({ t: p.t, end: chosen[i + 1]?.t ?? end, label: `${clock(p.t)}${p.kind ? ` ${p.kind}` : ''}` }))
        footer = `${shots.length} shots in range${kept.length > limit ? `; ${kept.length} candidate frames thinned to ${limit} (raise count up to 200 for more)` : ''}`
      }
    }
    if (!media) for (const c of cells) {
      const top = this.visibleAt(c.t)[0]
      if (top) c.label = `${c.label ?? clock(c.t)} ${top.name.length > 24 ? `${top.name.slice(0, 24)}…` : top.name}`
    }
    let audio: SheetAudio | undefined
    if (a.audio) {
      if (span > MAX_AUDIO_SECONDS * FLICKS) throw new Error(`audio covers at most ${MAX_AUDIO_SECONDS / 60} minutes; narrow start/end or set audio=false`)
      if (media) {
        if (media.meta.hasAudio === false) throw new Error(`${a.mediaId} has no audio; set audio=false`)
        const data = await decode(app, media.path!, start / FLICKS, span / FLICKS)
        if (data) audio = { data, rate: RATE, start }
      } else { this.busy(); audio = await this.renderMix(start, end) }
    }
    const sourceWords = (t: Flicks) => {
      const words = index.words.filter(w => w.end > t - 1.5 * FLICKS && w.start < t + 1.5 * FLICKS)
      const said = words.map(w => w.start <= t && t < w.end ? `«${w.text}»` : w.text).join(' ')
      return words.length ? { note: `says "${said}"`, data: { words: said } } : {}
    }
    return renderSheets(app, {
      cells, columns: a.columns, labels: a.labels, flags: a.flags, format: a.format, audio, footer,
      source: media && { path: media.path!, width: media.meta.width, height: media.meta.height },
      describe: media ? sourceWords : t => this.cellInfo(index, t)
    })
  }

  private async shotList(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids
    const media = a.mediaId ? this.media(a.mediaId, true) : undefined
    const total = media ? media.meta.duration ?? FLICKS : app.duration()
    const start = media ? this.clockTime(a.start, 0) : await this.time(a.start, 0)
    const end = Math.min(total, media ? this.clockTime(a.end, total) : await this.time(a.end, total))
    if (end <= start) throw new Error('Empty range')
    const index = media ? buildSourceIndex(media.id, (await this.loadAnalyses()).get(media.path!)) : await this.index()
    const all = this.cuts(index, start, end, !media)
    if (media && !index.shots.length) throw new Error(`No shot cuts for ${a.mediaId}; run media_analyze first`)
    const MAX = 60, shots = all.slice(0, MAX)
    const grab = async (t: Flicks) => stats(await loadImage(media ? (await app.host!.media.poster(media.path!, t / FLICKS)) ?? '' : await frame(app, t, 160)))
    const out = []
    for (const [s, e] of shots) {
      // Three samples per shot: motion is how much the picture changes between them.
      const samples = await Promise.all([0.2, 0.5, 0.8].map(f => grab(Math.round(s + (e - s) * f))))
      const motion = (change(samples[0].pixels, samples[1].pixels) + change(samples[1].pixels, samples[2].pixels)) / 2
      const mid = Math.round((s + e) / 2)
      out.push({
        start: clock(s), end: clock(e), seconds: +((e - s) / FLICKS).toFixed(2),
        ...(media ? {} : { clips: this.visibleAt(mid).map(c => `${ids.show(c.id, 'c')} ${c.name.slice(0, 40)}`) }),
        motion: Math.round(Math.min(1, motion * 8) * 100) / 100, brightness: Math.round(samples[1].luma * 100) / 100, color: samples[1].color
      })
    }
    const lengths = all.map(([s, e]) => (e - s) / FLICKS).sort((x, y) => x - y)
    return text({
      range: `${clock(start)}–${clock(end)}`, shots: all.length, averageSeconds: +(lengths.reduce((x, y) => x + y, 0) / lengths.length).toFixed(2), medianSeconds: +lengths[lengths.length >> 1].toFixed(2),
      legend: 'motion 0 = static, 1 = the picture changes completely within the shot; brightness 0–1; color = average',
      list: out, ...(all.length > MAX ? { more: `${all.length - MAX} more shots; continue with start=${clock(all[MAX][0])}` } : {})
    })
  }

  /** Per audio clip in [start, end): its own source level (not the mix). */
  private async clipLevels(start: Flicks, end: Flicks, only?: Set<string>) {
    const clips = this.app.timeline().tracks.filter(t => t.kind === 'audio' && !t.muted).flatMap(t => t.clips.filter(c => c.start < end && clipEnd(c) > start && (!only || only.has(c.id)))).slice(0, 40)
    const levels = new Map<string, { clip: Clip; peak: number; momentaryMax: number; integrated: number }>()
    for (const clip of clips) {
      const src = await clipSource(this.app, clip)
      if (!src) continue
      const r = new LoudnessMeter(src.data, src.rate).measure()
      levels.set(clip.id, { clip, peak: r.peak, momentaryMax: r.momentaryMax, integrated: r.integrated })
    }
    return levels
  }

  /** Lint with audio/frame measurements; `mix` reuses an already rendered mix. */
  private async lint(start: Flicks, end: Flicks, o: { audio: boolean; frames: boolean; rules?: string[] }, job?: CaptionJob, mix?: SheetAudio) {
    const app = this.app, ids = this.ids
    const unknown = (o.rules ?? []).filter(r => !LINT_RULES.some(x => x.id === r))
    if (unknown.length) throw new Error(`Unknown rules ${unknown.join(', ')}; rules: ${LINT_RULES.map(r => r.id).join(', ')}`)
    const m: LintMeasurements = { measureText: this.measure }
    const checked: Record<string, unknown> = { layout: true }
    const audible = app.timeline().tracks.some(t => t.kind === 'audio' && !t.muted && t.clips.some(c => c.start < end && clipEnd(c) > start))
    if (o.audio && audible) {
      if (end - start > MAX_AUDIO_SECONDS * FLICKS) checked.audio = `skipped: more than ${MAX_AUDIO_SECONDS / 60} minutes; narrow start/end`
      else {
        if (job) Object.assign(job, { phase: 'audio', message: 'Rendering and measuring the mix' })
        mix ??= await this.renderMix(start, end)
        const meter = new LoudnessMeter(mix.data, mix.rate), all = meter.measure()
        const at = (s: number) => start + Math.round(s * FLICKS)
        m.mixSilences = meter.silences(-50, 1).map(([x, y]) => [at(x), at(y)])
        m.mixClipping = all.clipTimes.map(at)
        m.clipLevels = new Map([...(await this.clipLevels(start, end)).entries()].map(([id, l]) => [id, { peak: l.peak, momentaryMax: l.momentaryMax }]))
        checked.audio = true
      }
    } else checked.audio = o.audio ? 'no audible clips' : false
    if (o.frames) {
      if (job) Object.assign(job, { phase: 'frames', message: 'Sampling frames' })
      const n = Math.min(240, Math.max(2, Math.ceil((end - start) / FLICKS * 2)))
      const frames: { t: Flicks; luma: number; diff: number }[] = []
      let prev: Uint8ClampedArray | undefined
      for (let i = 0; i < n; i++) {
        const t = Math.round(start + (end - start) * i / n)
        const s = stats(await loadImage(await frame(app, t, 96)))
        frames.push({ t, luma: s.luma, diff: prev ? change(prev, s.pixels) : 1 }); prev = s.pixels
        if (job) job.progress = 0.5 + 0.5 * i / n
      }
      m.frames = frames
      checked.frames = `${n} samples, ${(n / ((end - start) / FLICKS)).toFixed(1)} per second`
    } else checked.frames = false
    const show = (v: string) => v.replace(/\b(?:cl|tr)_[\w-]+/g, id => ids.show(id, id.startsWith('tr_') ? 't' : 'c'))
    const issues = lintTimeline(app, { start, end }, m, { rules: o.rules }).map(i => ({ rule: i.rule, severity: i.severity, start: clock(i.start), end: clock(i.end), clipIds: i.clipIds.map(id => ids.show(id, 'c')), message: show(i.message), ...(i.suggestedFix ? { suggestedFix: show(i.suggestedFix) } : {}) }))
    return { issues, checked }
  }

  private async audioAnalyze(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids
    const media = a.mediaId ? this.media(a.mediaId) : undefined
    if (media?.meta.hasAudio === false) throw new Error(`${a.mediaId} has no audio`)
    const total = media ? media.meta.duration ?? 0 : app.duration()
    const start = media ? this.clockTime(a.start, 0) : await this.time(a.start, 0)
    const end = Math.min(total, media ? this.clockTime(a.end, Math.min(total, start + MAX_AUDIO_SECONDS * FLICKS)) : await this.time(a.end, total))
    if (end <= start) throw new Error('audio_analyze needs end after start')
    if (end - start > MAX_AUDIO_SECONDS * FLICKS) throw new Error(`audio_analyze covers at most ${MAX_AUDIO_SECONDS / 60} minutes; pass start/end`)
    if (!media && !app.timeline().tracks.some(t => t.kind === 'audio' && !t.muted && t.clips.some(c => c.start < end && clipEnd(c) > start))) throw new Error('No audible clips in this range (audio tracks only; muted tracks are skipped)')
    return this.job('audio', a.wait, async job => {
      Object.assign(job, { phase: 'render', message: media ? 'Decoding the source' : 'Rendering the mix' })
      let pcm: SheetAudio & { path?: string }
      if (media) {
        const data = await decode(app, media.path!, start / FLICKS, (end - start) / FLICKS)
        if (!data) throw new Error('Could not decode the source audio')
        pcm = { data, rate: RATE, start }
      } else pcm = await this.renderMix(start, end)
      Object.assign(job, { phase: 'measure', progress: 0.5, message: 'Measuring' })
      const meter = new LoudnessMeter(pcm.data, pcm.rate)
      const { lines, json } = summary(meter, start, media ? `Source ${ids.show(media.id, 'm')} ${clock(start)}–${clock(end)}` : `Rendered mix ${clock(start)}–${clock(end)} (as exported)`)
      const at = (s: number) => clock(start + Math.round(s * FLICKS))
      // Speech and music share from the analysis (media_analyze), not from the signal.
      const index = media ? buildSourceIndex(media.id, (await this.loadAnalyses()).get(media.path!)) : await this.index()
      const speech = merge(index.words.map(w => [w.start, w.end]), 0.8 * FLICKS), music = merge(index.events.filter(e => MUSIC.test(e.cue)).map(e => [e.start, e.end]))
      const share = { speech: pct(covered(speech, start, end), end - start), music: pct(covered(music, start, end), end - start) }
      const out: Record<string, unknown> = { ...json, speechPercent: share.speech, musicPercent: share.music }
      lines.push(index.words.length || index.events.length ? `Content (from media_analyze): speech ${share.speech}% of the range, music ${share.music}%` : 'Content: no analysis; media_analyze the sources for the speech/music share')
      if (!media) {
        const only = a.clipIds ? new Set((a.clipIds as string[]).map(v => ids.resolve(v))) : undefined
        const levels = await this.clipLevels(start, end, only)
        const clips = app.timeline().tracks.filter(t => t.kind === 'audio' && !t.muted).flatMap(t => t.clips.filter(c => c.start < end && clipEnd(c) > start && (!only || only.has(c.id))))
        lines.push('Per clip: the mix while it plays (overlapping clips share it) | its own source level at 0 dB:')
        const perClip = []
        for (const c of clips) {
          const from = Math.max(start, c.start), to = Math.min(end, clipEnd(c))
          const gain = c.properties.find(p => p.type === 'volume')?.params.gain
          const r = meter.measure((from - start) / FLICKS, (to - start) / FLICKS), own = levels.get(c.id)
          const silent = own ? own.momentaryMax < -50 : r.momentaryMax < -50
          lines.push(`  ${ids.show(c.id, 'c')} ${clock(from)}–${clock(to)} ${JSON.stringify(c.name)}${gain ? ` volume ${gain.keyframes?.length ? 'keyframed' : `${gain.value} dB`}` : ''}: ${show(r, at)}${own ? ` | source ${formatDb(own.integrated)} LUFS, peak ${formatDb(own.peak)} dBFS` : ''}${silent ? ' — SILENT: nothing audible in its source range (check sourceIn, volume or mute)' : ''}`)
          perClip.push({ id: ids.show(c.id, 'c'), name: c.name, start: clock(from), end: clock(to), volume: gain ? (gain.keyframes?.length ? 'keyframed' : gain.value) : 0, mix: { peak: round1(r.peak), integrated: round1(r.integrated), momentaryMax: round1(r.momentaryMax), clipped: r.clipped }, ...(own ? { source: { peak: round1(own.peak), integrated: round1(own.integrated) } } : {}), silent })
        }
        out.clips = perClip
      }
      if (a.transcribe) {
        const bridge = app.host!.analysis, status = bridge && await bridge.status()
        if (!bridge || !status?.available.includes('speech')) lines.push('Transcript: speech model unavailable; run media_analyze once to install it.')
        else {
          Object.assign(job, { phase: 'transcribe', progress: 0.7, message: 'Transcribing' })
          const heard = media ? await bridge.run(media.path!, { parts: ['speech'], range: { start, end } }) : await bridge.run((pcm as { path: string }).path, { parts: ['speech'] })
          const shift = media ? 0 : start, sentences = heard.sentences.map(s => ({ start: clock(s.start + shift), end: clock(s.end + shift), text: heard.words.slice(s.words[0], s.words[1]).map(w => `${w.text}${w.p < 0.4 ? '?' : ''}`).join(' ') }))
          lines.push(`Heard (${media ? 'source' : 'timeline'} time, ${heard.words.length} words; cut-off or garbled words show up as such):`, ...sentences.map(s => `  ${s.start}–${s.end} ${s.text}`))
          if (!sentences.length) lines.push('  (no speech recognized)')
          out.heard = sentences
        }
      }
      const content: CallToolResult['content'] = [{ type: 'text', text: a.format === 'json' ? JSON.stringify(out) : lines.join('\n') }]
      if (a.waveform) { const url = envelopeImage(meter, start); content.push({ type: 'image', mimeType: 'image/png', data: url.slice(url.indexOf(',') + 1) }) }
      return { content }
    })
  }

  private async audioNormalize(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids, copy = staging(app)
    const lines: string[] = []
    let changed = 0
    for (const value of a.clipIds as string[]) {
      const found = findClip(copy.timeline(), ids.resolve(value))
      if (!found) throw new Error(`Unknown clip ${value}; refresh timeline_get`)
      const { clip, track } = found
      if (track.kind !== 'audio') { lines.push(`${value}: not an audio clip; normalize its linked audio clip`); continue }
      if (track.locked) { lines.push(`${value}: track locked, skipped`); continue }
      const gain = clip.properties.find(p => p.type === 'volume')
      if (gain?.params.gain?.keyframes?.length) { lines.push(`${value}: volume is keyframed, skipped (clear_keyframes first)`); continue }
      const src = await clipSource(app, clip)
      const level = src && new LoudnessMeter(src.data, src.rate).measure().integrated
      if (level === null || level === undefined || !Number.isFinite(level)) { lines.push(`${value}: silent or no source audio, skipped`); continue }
      const before = Number(gain?.params.gain?.value ?? 0), after = Math.round(Math.max(-60, Math.min(24, a.target - level)) * 10) / 10
      lines.push(`${ids.show(clip.id, 'c')} ${JSON.stringify(clip.name)}: source ${formatDb(level)} LUFS; volume ${before} → ${after} dB (plays at ${formatDb(level + before)} → ${formatDb(level + after)} LUFS)`)
      if (after === before) continue
      const propId = gain?.id ?? copy.edit.addProperty(clip.id, 'volume')
      if (!propId) throw new Error('The volume property is unavailable')
      copy.edit.setParam(clip.id, propId, 'gain', after, { at: 0 })
      changed++
    }
    if (changed && !a.dryRun) commit(app, copy.project(), `normalize ${changed} clips to ${a.target} LUFS`)
    lines.push(a.dryRun ? 'Dry run: nothing changed.' : changed ? `One undo step; revision ${this.revision}.` : 'Nothing to change.')
    return text(lines.join('\n'))
  }

  private async silenceTrim(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app
    const { start, end } = await this.range(a)
    this.busy()
    const mix = await this.renderMix(start, end)
    const meter = new LoudnessMeter(mix.data, mix.rate)
    const min = this.clockTime(a.minSilence, 0.7 * FLICKS) / FLICKS, keep = this.clockTime(a.keep, 0.15 * FLICKS)
    const snap = (t: Flicks) => snapToFrame(t, app.fps())
    const cuts = meter.silences(a.threshold, min).map(([x, y]) => [snap(start + Math.round(x * FLICKS) + keep), snap(start + Math.round(y * FLICKS) - keep)] as [Flicks, Flicks]).filter(([x, y]) => y - x >= frameDuration(app.fps()))
    if (!cuts.length) return text(`No silence quieter than ${a.threshold} LUFS for ${min}s or longer in ${clock(start)}–${clock(end)}.`)
    const removed = cuts.reduce((n, [x, y]) => n + y - x, 0)
    const list = cuts.map(([x, y]) => `${clock(x)}–${clock(y)} (${((y - x) / FLICKS).toFixed(2)}s)`)
    if (!a.apply) return text(`${cuts.length} silent stretches (keeping ${keep / FLICKS}s each side), ${(removed / FLICKS).toFixed(1)}s in total:\n${list.join('\n')}\napply=true ripple-deletes them on every unlocked track (lock a music bed's track to keep it whole).`)
    // Later cuts first so earlier times stay valid.
    const result = applyEdits(app, { ops: [...cuts].reverse().map(([x, y]) => ({ op: 'ripple_delete', start: x, end: y })) }, this.ids, await this.loadAnalyses(), { fonts: await this.fonts() })
    return text(`Removed ${cuts.length} silent stretches, ${(removed / FLICKS).toFixed(1)}s:\n${list.join('\n')}\n${result.split('\n').at(-1)} revision ${this.revision}`)
  }

  private async beatGrid(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids
    if (!a.clipId === !a.mediaId) throw new Error('Give exactly one of clipId (timeline) or mediaId (source)')
    let path: string, lo: Flicks, hi: Flicks, toTimeline: ((t: Flicks) => Flicks) | undefined, label: string
    if (a.clipId) {
      const found = findClip(app.timeline(), ids.resolve(a.clipId))
      if (!found) throw new Error(`Unknown clip ${a.clipId}`)
      const clip = found.clip, media = clip.mediaId ? app.project().media[clip.mediaId] : undefined
      if (!media?.path || media.meta.hasAudio === false) throw new Error(`${a.clipId} has no source audio`)
      const map = app.edit.timeMap(clip)
      ;({ lo, hi } = sourceSpan(clip, map))
      path = media.path
      if (map.constant !== null && !map.reversed) toTimeline = t => clip.start + Math.round((t - clip.sourceIn) / map.constant!)
      label = `${ids.show(clip.id, 'c')} ${JSON.stringify(clip.name)}`
    } else {
      const media = this.media(a.mediaId)
      lo = this.clockTime(a.start, 0); hi = Math.min(media.meta.duration ?? 0, this.clockTime(a.end, media.meta.duration ?? 0))
      path = media.path!
      label = ids.show(media.id, 'm')
    }
    hi = Math.min(hi, lo + MAX_AUDIO_SECONDS * FLICKS)
    if (hi <= lo) throw new Error('Empty range')
    const data = await decode(app, path, lo / FLICKS, (hi - lo) / FLICKS)
    if (!data) throw new Error('Could not decode the audio')
    const grid = detectBeats(toMono(data), RATE, { minBpm: a.minBpm, maxBpm: a.maxBpm })
    const src = (s: number) => lo + Math.round(s * FLICKS)
    const beats = grid.beats.map(src), downbeats = grid.downbeats.map(src)
    const previous = this.beatGrids.get(path)
    // Keep beats analyzed elsewhere in the same file.
    const keepOut = (list: Flicks[] = []) => list.filter(t => t < lo || t >= hi)
    this.beatGrids.set(path, { beats: [...keepOut(previous?.beats), ...beats].sort((x, y) => x - y), downbeats: [...keepOut(previous?.downbeats), ...downbeats].sort((x, y) => x - y) })
    const at = toTimeline ?? ((t: Flicks) => t)
    const list = (l: Flicks[], max: number) => ({ count: l.length, times: l.slice(0, max).map(t => clock(at(t))), ...(l.length > max ? { more: l.length - max } : {}) })
    return text({
      of: label, time: toTimeline ? 'timeline' : a.clipId ? 'source (the clip has keyframed or reversed speed)' : 'source', range: `${clock(at(lo))}–${clock(at(hi))}`,
      bpm: Math.round(grid.bpm * 10) / 10, confidence: Math.round(grid.confidence * 100) / 100, beatSeconds: +(60 / grid.bpm).toFixed(3),
      beats: list(beats, 300), downbeats: list(downbeats, 100), onsets: list(grid.onsets.map(src), 200),
      next: a.clipId ? `snap_to_beats with beatClipId=${a.clipId} snaps clips or keyframes to these` : 'Place the music, then beat_grid its clip to snap edits to it'
    })
  }

  /** Metrics of an edit (any app over a project). */
  private stats(app: CascadeAPI) {
    const tl = app.timeline(), duration = app.duration(), minutes = duration / FLICKS / 60
    const index = buildIndex(app.project(), this.analyses, (c) => app.edit.timeMap(c))
    const visual = tl.tracks.filter(t => t.kind === 'visual' && !t.hidden)
    const edges = [...new Set([0, ...index.shots.map(s => s.t), ...visual.flatMap(t => t.clips.filter(c => app.registries.mediaTypes.get(c.type)?.timeBased || c.type === 'image').flatMap(c => [c.start, clipEnd(c)]))].filter(t => t >= 0 && t < duration))].sort((a, b) => a - b)
    const shots = edges.map((t, i) => ((edges[i + 1] ?? duration) - t) / FLICKS).filter(s => s > 0.05)
    const sorted = [...shots].sort((a, b) => a - b)
    const texts = visual.flatMap(t => t.clips.filter(c => c.properties.some(p => p.type === 'text')))
    const captions = texts.filter(c => (c.data as { caption?: unknown } | undefined)?.caption || /caption/i.test(tl.tracks.find(t => t.clips.includes(c))?.name ?? ''))
    const speech = merge(index.words.map(w => [w.start, w.end]), 0.8 * FLICKS), music = merge(index.events.filter(e => MUSIC.test(e.cue)).map(e => [e.start, e.end]))
    const r = (v: number) => Math.round(v * 100) / 100
    return {
      duration: clock(duration), seconds: r(duration / FLICKS),
      tracks: { visual: tl.tracks.filter(t => t.kind === 'visual').length, audio: tl.tracks.filter(t => t.kind === 'audio').length },
      clips: tl.tracks.reduce((n, t) => n + t.clips.length, 0),
      shots: shots.length, averageShotSeconds: r(shots.reduce((a, b) => a + b, 0) / Math.max(1, shots.length)), medianShotSeconds: r(sorted[sorted.length >> 1] ?? 0),
      longestShotSeconds: r(sorted.at(-1) ?? 0), shortestShotSeconds: r(sorted[0] ?? 0), cutsPerMinute: r(Math.max(0, shots.length - 1) / Math.max(minutes, 1e-9)),
      speechPercent: pct(covered(speech, 0, duration), duration), words: index.words.length, wordsPerMinute: r(index.words.length / Math.max(minutes, 1e-9)),
      fillers: index.words.filter(w => w.filler).length, musicPercent: pct(covered(music, 0, duration), duration),
      textOnScreenPercent: pct(covered(merge(texts.map(c => [c.start, clipEnd(c)])), 0, duration), duration), textClips: texts.length, captions: captions.length,
      gapsSeconds: r((duration - covered(merge(visual.flatMap(t => t.clips.map(c => [c.start, clipEnd(c)]))), 0, duration)) / FLICKS),
      ...(index.unanalyzed.length ? { note: `${index.unanalyzed.length} clips have no analysis; speech/music numbers cover analyzed clips only` } : {})
    }
  }

  private async inspect(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app
    const { start, end } = await this.range(a)
    const audible = end - start <= MAX_AUDIO_SECONDS * FLICKS && app.timeline().tracks.some(t => t.kind === 'audio' && !t.muted && t.clips.some(c => c.start < end && clipEnd(c) > start))
    let preview: { jobId: string; path: string } | undefined
    const result = await this.job('inspect', 120, async job => {
      Object.assign(job, { phase: 'audio', message: 'Rendering the mix' })
      const mix = audible ? await this.renderMix(start, end) : undefined
      const { issues, checked } = await this.lint(start, end, { audio: true, frames: true }, job, mix)
      const lines = [`Inspect ${clock(start)}–${clock(end)}`, `Lint: ${issues.length ? `${issues.length} issues` : 'no issues'} (audio ${checked.audio === true ? 'measured' : checked.audio}, frames ${checked.frames})`]
      for (const i of issues.slice(0, 40)) lines.push(`  [${i.severity}] ${i.rule} ${i.start}–${i.end}${i.clipIds.length ? ` ${i.clipIds.join(',')}` : ''}: ${i.message}${i.suggestedFix ? ` → ${i.suggestedFix}` : ''}`)
      if (issues.length > 40) lines.push(`  … ${issues.length - 40} more; timeline_lint for all`)
      if (mix) lines.push(...summary(new LoudnessMeter(mix.data, mix.rate), start, 'Audio (mix)').lines)
      else lines.push('Audio: nothing audible in range (or longer than 10 minutes)')
      Object.assign(job, { phase: 'sheet', message: 'Contact sheet' })
      const index = await this.index()
      const sheet = await this.contactSheetCells(start, end, index, mix)
      return { content: [{ type: 'text', text: lines.join('\n') }, ...sheet.content] }
    })
    if (a.preview) {
      // A small watchable render for the user; the agent gets the path.
      if (!app.registries.exporters.get('mp4-h264')) throw new Error('The MP4 exporter is unavailable')
      const path = `${(await app.host!.info()).paths.userData}/previews/preview-${Date.now()}.mp4`
      const w = 640, h = Math.round(w * app.project().settings.height / app.project().settings.width / 2) * 2
      const jobId = await app.host!.export.start(await prepareExportRequest(app, { exporter: 'mp4-h264', output: path, options: {}, width: w, height: h, range: { start, end } }))
      if (!this.jobs.has(jobId)) this.jobs.set(jobId, { jobId, state: 'preparing', framesDone: 0, framesTotal: 0, fps: 0 })
      this.agentExports.add(jobId)
      preview = { jobId, path }
    }
    return preview ? { ...result, content: [...result.content, { type: 'text', text: `Preview for the user: ${preview.path} (export job ${preview.jobId}; poll job_get)` }] } : result
  }
  /** The smart sheet inspect_range shows: 12 cells, waveforms when there is a mix. */
  private contactSheetCells(start: Flicks, end: Flicks, index: TIndex, mix?: SheetAudio) {
    const shots = this.cuts(index, start, end, true), span = end - start, limit = 12
    const picks = shots.map(([s, e]) => Math.round((s + e) / 2))
    for (let i = 0; i < limit; i++) picks.push(Math.round(start + span * (i + 0.5) / limit))
    const sorted = [...new Set(picks)].sort((x, y) => x - y)
    const chosen = sorted.length > limit ? Array.from({ length: limit }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (limit - 1))]) : sorted
    const cells: Cell[] = chosen.map((t, i) => ({ t, end: chosen[i + 1] ?? end }))
    return renderSheets(this.app, { cells, labels: true, flags: true, format: 'sheet', audio: mix, describe: t => this.cellInfo(index, t) })
  }

  private async validateStyle(style: Record<string, Record<string, unknown>> | undefined) {
    const fonts = await this.fonts()
    for (const [type, values] of Object.entries(style ?? {})) for (const [paramId, value] of Object.entries(values)) {
      const def = this.app.edit.paramDef(type, paramId)
      if (!def || (type === 'text' && paramId === 'text')) throw new Error(`style: ${type}.${paramId} is not a caption style parameter; see registry_list only=["properties"]`)
      validateValue(def, value, fonts)
    }
  }
  private visualTrack(value: string | undefined) {
    if (!value) return undefined
    const track = this.app.timeline().tracks.find(t => t.id === this.ids.resolve(value))
    if (!track || track.kind !== 'visual' || track.locked) throw new Error(`${value} is not an unlocked visual track; see timeline_get`)
    return track
  }

  private async captions(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, host = app.host!, ids = this.ids
    const captions = app.services.get('captions') as CaptionsService | undefined
    if (!captions) throw new Error('The captions plugin is not active')
    if (a.scope === 'clip' && !a.clipId === !a.mediaId) throw new Error('scope=clip needs exactly one of clipId (from timeline_get) or mediaId (from media_list)')
    if ([...this.captionJobs.values()].some(j => j.state === 'running')) throw new Error('A captions job is already running; poll job_get')
    const track = this.visualTrack(a.trackId)
    await this.validateStyle(a.style)
    // Timeline scope: every clip with speech, in time order (an audio clip, or a video clip without linked audio).
    const targets = a.scope === 'timeline'
      ? app.timeline().tracks.flatMap(t => t.muted ? [] : t.clips.filter(c => {
        const m = c.mediaId ? app.project().media[c.mediaId] : undefined
        if (!m?.path || m.meta.hasAudio === false) return false
        return t.kind === 'audio' || (c.type === 'video' && !app.timeline().tracks.some(o => o.kind === 'audio' && o.clips.some(x => x.linkId && x.linkId === c.linkId)))
      })).sort((x, y) => x.start - y.start).map(c => ({ clipId: c.id }))
      : [{ clipId: a.clipId && ids.resolve(a.clipId), mediaId: a.mediaId && ids.resolve(a.mediaId) }]
    if (!targets.length) throw new Error('No clips with sound on the timeline')
    const jobId = `captions-${this.captionJobs.size + 1}`
    const job: CaptionJob = { jobId, state: 'running', phase: 'starting', progress: 0, message: 'Starting' }
    this.captionJobs.set(jobId, job)
    const off = host.transcribe.onProgress(p => { if (job.state === 'running') Object.assign(job, { phase: p.phase, progress: Math.round(p.progress * 100) / 100, message: `${targets.length > 1 ? `${p.message} (clip ${done + 1} of ${targets.length})` : p.message}` }) })
    let done = 0
    const run = async () => {
      let trackId = track?.id, total = 0
      for (const target of targets) {
        const clipIds = await captions.generate({ ...target, language: a.language, trackId, style: a.style, replace: a.replace })
        done++
        total += clipIds.length
        // Later clips' captions go on the track the first ones made.
        trackId ??= clipIds.length ? app.timeline().tracks.find(t => t.clips.some(c => c.id === clipIds[0]))?.id : undefined
      }
      return { total, trackId }
    }
    run().then(({ total, trackId }) => Object.assign(job, total
      ? { state: 'done', progress: 1, message: `Created ${total} caption clips on ${trackId ? ids.show(trackId, 't') : 'a new track'}${track ? '' : ' (a new Captions track)'}${targets.length > 1 ? ` from ${targets.length} clips (one undo step each)` : ''}. Pass trackId=${trackId ? ids.show(trackId, 't') : '…'} to regenerate in place; restyle with copy_properties; check with timeline_lint rules=["reading-speed","safe-area","text-overflow"]`, clips: total }
      : { state: 'done', progress: 1, message: 'No captions created (no speech found, or the user declined the model download)', clips: 0 }))
      .catch(error => Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(off)
    return text({ jobId, next: 'Poll job_get. The first run may wait on a model download prompt in the editor.' })
  }

  private async captionsFromScript(a: Record<string, any>): Promise<CallToolResult> {
    const app = this.app, ids = this.ids
    const track = this.visualTrack(a.trackId)
    await this.validateStyle(a.style)
    const { start, end } = await this.range(a)
    const index = await this.index()
    const words = index.words.filter(w => w.start >= start && w.end <= end).sort((x, y) => x.start - y.start)
    if (!words.length) throw new Error('No transcribed speech in this range; run media_analyze on the speech sources')
    const script = String(a.script).trim()
    const blocks = (/\n\s*\n/.test(script) ? script.split(/\n\s*\n/) : script.split('\n')).map(s => s.trim()).filter(Boolean)
    const clips: Clip[] = [], missing: string[] = []
    let cursor = 0
    for (const block of blocks) {
      const run = findSpoken(words, block, cursor)[0]
      if (!run) { missing.push(block); continue }
      const [i, j] = run
      const from = Math.max(words[i].start, clips.length ? clipEnd(clips.at(-1)!) : 0), to = words[j].end
      if (to - from < frameDuration(app.fps())) { missing.push(block); continue }
      clips.push(captionClip(block, from, to, a.style, { script: true }))
      cursor = j + 1
    }
    if (!clips.length) throw new Error(`None of the ${blocks.length} script lines match the transcript in ${clock(start)}–${clock(end)}; check transcript_get`)
    let trackId: string
    if (track) {
      trackId = track.id
      app.edit.placeClips(track.id, clips, { label: 'Agent: captions from script', replace: a.replace ? [clips[0].start, clipEnd(clips.at(-1)!)] : undefined })
    } else trackId = app.edit.addTrack('visual', { name: 'Captions', clips, label: 'Agent: captions from script' })
    const lines = [`Placed ${clips.length} of ${blocks.length} lines on ${ids.show(trackId, 't')} (one undo step):`, ...clips.map(c => `  ${ids.show(c.id, 'c')} ${clock(c.start)}–${clock(clipEnd(c))} ${JSON.stringify(c.name.slice(0, 60))}`)]
    if (missing.length) lines.push(`Not found in the transcript (in order after the previous match): ${missing.map(m => JSON.stringify(m.slice(0, 60))).join(', ')}`)
    return text(lines.join('\n'))
  }

  private async writePlugin(name: string, code: string): Promise<CallToolResult> {
    const host = this.app.host!, ph = this.app.services.get('plugins') as PluginHost
    if (!ph) throw new Error('Plugin host is not ready')
    const previous = ph.list().find(p => p.source === name)
    const previousDefinition = previous?.def
    let changed = false
    const off = host.plugins.onChange(files => { if (files.some(f => f.name === name)) changed = true })
    try {
      const file = await host.plugins.write(name, code)
      if (file.error) throw new Error(`Plugin build failed:\n${file.error}`)
      for (let i = 0; i < 100; i++) {
        const loaded = ph.list().find(p => p.source === name)
        if (changed && loaded && loaded.def !== previousDefinition) {
          if (loaded.error) throw new Error(`Plugin activation failed: ${loaded.error}`)
          if (loaded.active) return text(`Built and hot reloaded ${name} (${loaded.def.id}); registry_list now includes its contributions.`)
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Plugin built but hot reload was not confirmed within 10 seconds. Inspect plugin_list for activation errors before using it.')
    } finally { off() }
  }
}
export const mcpPlugin = definePlugin({
  id: 'cascade.mcp', name: 'Agent tools',
  activate(ctx) {
    if (ctx.env !== 'editor' || !ctx.app.host) return
    const handlers = new AgentTools(ctx.app)
    ctx.app.services.set('agent-tools', handlers)
    let queue = Promise.resolve<unknown>(undefined)
    ctx.track({ dispose: ctx.app.host.mcp.onCall(call => {
      const result = queue.then(() => handlers.call(call))
      queue = result.catch(() => {})
      return result
    }) })
    ctx.track(ctx.app.doc.onChange.on(e => { handlers.revision++; handlers.history.push({ label: e.label, source: e.source }); if (handlers.history.length > 100) handlers.history.shift() }))
    ctx.track({ dispose: ctx.app.host.export.onProgress(p => { handlers.jobs.set(p.jobId, p) }) })
  }
})
