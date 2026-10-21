import { definePlugin } from '@core/plugin-api'
import { prepareExportRequest } from '../export-request'
import { CascadeApp, type CascadeAPI } from '@core/app'
import type { Session } from '../../../renderer/app/session'
import type { PluginHost } from '@core/plugin-host'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ExportProgress, McpCall } from '@shared/ipc'
import { formatTimecode, snapToFrame, FLICKS, type Flicks } from '@shared/time'
import { clipEnd, type Clip } from '@shared/project'
import { defaultParams } from '@core/evaluate'
import { tools } from '../../../main/mcp/catalog'
import { Ids, applyEdits, resolveAnchor, staging, commit } from './edits'
import { LoudnessMeter, formatDb, type LoudnessReading } from './loudness'
import { BUILTIN_FONTS } from '../params/fonts'
import { sourceSpan } from '@core/time-remap'
import { frame, imageResult, sheet } from './images'
import { pluginDocs } from './plugin-docs'
import type { CaptionsService } from '../captions'
import type { SourceAnalysis } from '@shared/analysis'
import { buildIndex, buildSourceIndex, formatTranscript, searchTranscript, SOURCE_LEGEND, type Analyses, type TIndex, type TWord, type TSentence } from './transcript'

interface CaptionJob { jobId: string; state: 'running' | 'done' | 'error'; phase: string; progress: number; message: string; clips?: number; report?: string }

const TERMINAL = ['done', 'error', 'cancelled']
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
export class AgentTools {
  readonly ids = new Ids()
  readonly jobs = new Map<string, ExportProgress>()
  readonly captionJobs = new Map<string, CaptionJob>()
  readonly analyses: Analyses = new Map()
  readonly history: { label: string; source: string }[] = []
  /** Exports the agent started (the export panel's own jobs also land in `jobs`). */
  readonly agentExports = new Set<string>()
  constructor(readonly app: CascadeAPI) {}
  /** Where the user is: playhead (+ playing) and selected clips, in agent ids. Empty without an open project. */
  editorState(): string {
    const app = this.app
    if ((this.app.services.get('session') as Session | undefined)?.screen() !== 'editor') return ''
    const t = app.playback.time.get(), clips = app.selection.clips.get().map(id => this.ids.show(id, 'c'))
    return `playhead ${formatTimecode(t, app.fps())} (${t} flicks)${app.playback.playing.get() ? ', playing' : ''}${clips.length ? `; selected ${clips.join(', ')}` : '; nothing selected'}`
  }
  /** editorState plus every clip under the playhead, with clip-local and (time-based media) source time. */
  private playhead(): string {
    const app = this.app, ids = this.ids, t = app.playback.time.get(), tc = (v: Flicks) => formatTimecode(v, app.fps())
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
    const LABELS: Record<string, string> = { analysis: 'Analyzing media', captions: 'Generating captions', 'audio-check': 'Checking audio' }
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
  /** One line per clip. Concise drops parameters at their defaults (and properties left entirely at defaults). */
  private timeline(detailed = false) {
    const app = this.app, ids = this.ids, tc = (t: Flicks) => formatTimecode(t, app.fps())
    const lines = [`${app.timeline().name} | duration ${tc(app.duration())} (${app.duration()}) | times in flicks; 1s=${FLICKS}`, `user: ${this.editorState()}`]
    for (const tr of app.timeline().tracks) {
      lines.push(`${ids.show(tr.id, 't')} ${tr.name} [${tr.kind}${tr.locked ? ',locked' : ''}${tr.muted ? ',muted' : ''}${tr.hidden ? ',hidden' : ''}]`)
      for (const c of tr.clips) lines.push(`  ${ids.show(c.id, 'c')} ${tc(c.start)}–${tc(clipEnd(c))} [${c.start}, ${clipEnd(c)}) ${c.type} ${JSON.stringify(c.name)}${this.clipSource(c)}${this.clipProperties(c, detailed)}`)
    }
    for (const m of app.timeline().markers) lines.push(`marker ${ids.show(m.id, 'k')} ${formatTimecode(m.t, app.fps())} ${JSON.stringify(m.name)}`)
    return lines.join('\n')
  }
  /** Source, speed and link of a clip: ` m1 src 00:10:00.00–00:10:02.00 speed 2× ◀ linked=c4`. */
  private clipSource(c: Clip) {
    const app = this.app, ids = this.ids
    const media = c.mediaId ? app.project().media[c.mediaId] : undefined
    let out = ''
    if (media?.path) out += ` ${ids.show(media.id, 'm')}`
    if (media && app.registries.mediaTypes.get(c.type)?.timeBased) {
      const map = app.edit.timeMap(c), { lo, hi } = sourceSpan(c, map)
      out += ` src ${formatTimecode(lo, app.fps())}–${formatTimecode(hi, app.fps())}`
      const speed = map.constant === null ? `speed keyframed ${+map.min.toFixed(2)}–${+map.max.toFixed(2)}×` : map.constant !== 1 ? `speed ${+map.constant.toFixed(3)}×` : ''
      const remap = app.registries.properties.all().find(p => p.timeRemap)?.id
      const own = c.properties.some(p => p.type === remap && p.enabled)
      if (speed || map.reversed) out += ` ${[speed, map.reversed ? 'reversed' : ''].filter(Boolean).join(' ')}${own || !c.linkId ? '' : ' (from linked clip)'}`
    }
    if (c.linkId) {
      const partners = app.timeline().tracks.flatMap(t => t.clips.filter(x => x.id !== c.id && x.linkId === c.linkId))
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
  /** Sheet cells, one per shot in [start, end): the frame mid-shot, labeled with the shot's range. */
  private shotCells(boundaries: Flicks[], start: Flicks, end: Flicks, max: number) {
    const cuts = [...new Set([start, ...boundaries.filter(t => t > start && t < end)])].sort((a, b) => a - b)
    const cells = cuts.slice(0, max).map((t, i) => {
      const next = cuts[i + 1] ?? end
      return { t: Math.round((t + next) / 2), label: `${formatTimecode(t, this.app.fps())}–${formatTimecode(next, this.app.fps())}` }
    })
    const footer = cuts.length > max ? `${cuts.length - max} more shots; continue with start=${cuts[max]}` : `${cuts.length} shots in range`
    return { cells, footer }
  }
  /** Pull cached analyses for every file-backed source (cheap; nothing is computed). */
  private async loadAnalyses(): Promise<Analyses> {
    const bridge = this.app.host?.analysis
    if (!bridge) return this.analyses
    const paths = [...new Set(Object.values(this.app.project().media).map(m => m.path).filter((p): p is string => !!p))]
    await Promise.all(paths.map(async path => { this.analyses.set(path, await bridge.cached(path)) }))
    return this.analyses
  }
  private transcriptIds() {
    const ids = this.ids
    return { wordId: (w: TWord) => ids.show(w.key, 'w'), sentenceId: (s: TSentence) => ids.show(s.key, 's'), clipLabel: (c: { id: string }) => ids.show(c.id, 'c'), trackLabel: (t: { id: string; name: string }) => `${ids.show(t.id, 't')} ${t.name}` }
  }
  async call(call: McpCall): Promise<CallToolResult> {
    try {
      const def = tools.find(t => t.name === call.tool)
      if (!def) throw new Error(`Unknown tool ${call.tool}`)
      const a = def.schema.parse(call.args) as Record<string, any>
      const app = this.app, host = app.host!, ids = this.ids
      if (!['project_new', 'project_open', 'registry_list', 'plugin_api_docs', 'plugin_list', 'plugin_write', 'plugin_remove'].includes(call.tool)) this.projectRequired()
      switch (call.tool) {
        case 'project_get': return text(a.detail === 'detailed' ? app.project() : { name: app.project().name, path: this.session().path(), settings: app.project().settings, duration: app.duration(), timecode: formatTimecode(app.duration(), app.fps()), editor: this.editorState(), media: app.project().mediaOrder.length, tracks: app.timeline().tracks.map(t => ({ id: ids.show(t.id, 't'), name: t.name, kind: t.kind, locked: t.locked })) })
        case 'project_new': await this.session().newProject(a.name, a.settings ?? {}); return text(`Created ${app.project().name}; saved ${this.session().path()}`)
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
        case 'media_list': return text(app.project().mediaOrder.map(id => { const m = app.project().media[id]; return a.detail === 'detailed' ? { ...m, shortId: ids.show(id, 'm') } : { id: ids.show(id, 'm'), type: m.type, name: m.name, duration: m.meta.duration, path: m.path } }))
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
        case 'timeline_get': {
          const index = buildIndex(app.project(), await this.loadAnalyses(), (c) => app.edit.timeMap(c))
          const hint = index.words.length ? `transcript: ${index.words.length} words, ${index.events.length} sound events, ${index.shots.length} shot cuts on the timeline; read with transcript_get`
            : index.unanalyzed.length ? `transcript: none; media_analyze ${[...new Set(index.unanalyzed.map(u => ids.show(u.clip.mediaId!, 'm')))].join(', ')} to edit by words, intonation, sound events and shots` : ''
          const body = a.detail === 'detailed' ? `${this.timeline(true)}\n${JSON.stringify(app.timeline())}` : this.timeline()
          return text(hint ? `${body}\n${hint}` : body)
        }
        case 'playhead_get': return text(this.playhead())
        case 'playhead_set': {
          if (a.time === undefined && a.play === undefined) throw new Error('Give time and/or play')
          if (a.time !== undefined) {
            const t = typeof a.time === 'string' ? resolveAnchor(app.project(), await this.loadAnalyses(), ids, a.time, (c) => app.edit.timeMap(c)) : a.time
            app.playback.seek(snapToFrame(t, app.fps()))
          }
          if (a.play === true) app.playback.play()
          if (a.play === false) app.playback.pause()
          return text(this.playhead())
        }
        case 'timeline_apply_edits': return text(applyEdits(app, a, ids, await this.loadAnalyses(), { fonts: await this.fonts() }))
        case 'timeline_undo': return text(app.doc.undo() ? 'Undone' : 'Nothing to undo')
        case 'timeline_redo': return text(app.doc.redo() ? 'Redone' : 'Nothing to redo')
        case 'history_get': return text({ canUndo: app.doc.canUndo, undo: app.doc.undoLabel, canRedo: app.doc.canRedo, redo: app.doc.redoLabel, recentEvents: this.history.slice(-30) })
        case 'registry_list': {
          const r = app.registries
          return text({ mediaTypes: r.mediaTypes.all().map(({ id, name, track, extensions, defaultProperties }) => ({ id, name, track, extensions, defaultProperties })), properties: r.properties.all().map(({ id, name, description, params, appliesTo, stackable }) => ({ id, name, description, params, appliesTo: Array.isArray(appliesTo) ? appliesTo : 'predicate/default; validated when adding', stackable })), easings: r.easings.all().map(({ id, name, params }) => ({ id, name, params })), generators: r.generators.all().map(({ id, name, mediaType }) => ({ id, name, mediaType })), exporters: r.exporters.all().map(({ id, name, extension, options }) => ({ id, name, extension, options })), fonts: await this.fonts() })
        }
        case 'frame_get': {
          const t = typeof a.time === 'string' ? resolveAnchor(app.project(), await this.loadAnalyses(), ids, a.time, (c) => app.edit.timeMap(c)) : a.time
          return imageResult(await frame(app, t, a.width), `${typeof a.time === 'string' ? `${a.time} = ` : ''}${formatTimecode(t, app.fps())}`)
        }
        case 'contact_sheet': {
          if (!a.shots) return await sheet(app, a)
          const index = buildIndex(app.project(), await this.loadAnalyses(), (c) => app.edit.timeMap(c))
          const starts = app.timeline().tracks.filter(t => t.kind === 'visual' && !t.hidden).flatMap(t => t.clips.map(c => c.start))
          return await sheet(app, { columns: a.columns, ...this.shotCells([...index.shots.map(s => s.t), ...starts], a.start ?? 0, a.end ?? app.duration(), a.count ?? 24) })
        }
        case 'timeline_preview_sheet': {
          const at = async (v: number | string | undefined, fallback: number) => typeof v === 'string' ? resolveAnchor(app.project(), await this.loadAnalyses(), ids, v, (c) => app.edit.timeMap(c)) : v ?? fallback
          return await sheet(app, { ...a, start: await at(a.start, 0), end: await at(a.end, app.duration()) })
        }
        case 'media_contact_sheet': {
          const m = app.project().media[ids.resolve(a.mediaId)]
          if (!m?.path) throw new Error('Select file-backed media from media_list')
          if (!m.meta.hasVideo && m.type !== 'image') throw new Error('Source has no visual frames')
          const source = { path: m.path, duration: m.meta.duration ?? FLICKS, width: m.meta.width, height: m.meta.height }
          if (!a.shots) return await sheet(app, a, source)
          await this.loadAnalyses()
          const shots = buildSourceIndex(m.id, this.analyses.get(m.path)).shots.map(s => s.t)
          if (!shots.length) throw new Error(`No shot cuts for ${a.mediaId}; run media_analyze first`)
          return await sheet(app, { columns: a.columns, ...this.shotCells(shots, a.start ?? 0, a.end ?? source.duration, a.count ?? 24) }, source)
        }
        case 'plugin_api_docs': return text(pluginDocs)
        case 'plugin_list': { const ph = app.services.get('plugins') as PluginHost; return text({ files: await host.plugins.list(), loaded: ph?.list().map(p => ({ id: p.def.id, source: p.source, active: p.active, error: p.error })) }) }
        case 'plugin_write': return await this.writePlugin(a.name, a.code)
        case 'plugin_remove': await host.plugins.remove(a.name); return text(`Removed ${a.name}; hot unload requested`)
        case 'export_start': {
          if (!app.registries.exporters.get(a.exporter)) throw new Error('Unknown exporter; inspect registry_list')
          const start = a.start ?? 0, end = a.end ?? app.duration()
          if (end <= start || end > app.duration()) throw new Error('Export needs a nonempty range within the timeline')
          const jobId = await host.export.start(await prepareExportRequest(app, { exporter: a.exporter, output: await this.path(a.output), options: a.options, width: a.width, height: a.height, range: { start, end } }))
          if (!this.jobs.has(jobId)) this.jobs.set(jobId, { jobId, state: 'preparing', framesDone: 0, framesTotal: 0, fps: 0 })
          this.agentExports.add(jobId)
          return text({ jobId, next: 'Poll job_get' })
        }
        case 'job_get': {
          const job = () => this.jobs.get(a.jobId) ?? this.captionJobs.get(a.jobId)
          if (!job()) throw new Error('Unknown job; use a jobId from export_start, media_analyze, captions_generate or audio_check in this editor session')
          const until = Date.now() + a.wait * 1000
          while (Date.now() < until && !TERMINAL.includes(job()!.state)) await sleep(250)
          const { report, ...rest } = job() as CaptionJob
          return text(report ? `${JSON.stringify(rest, null, 2)}\n\n${report}` : rest)
        }
        case 'export_cancel': if (!this.jobs.has(a.jobId)) throw new Error('Unknown job'); await host.export.cancel(a.jobId); return text('Cancellation requested')
        case 'media_analyze': {
          const bridge = host.analysis
          if (!bridge) throw new Error('The analysis service is not available in this build')
          const media = app.project().media[ids.resolve(a.mediaId)]
          if (!media?.path || !(media.type === 'video' || media.type === 'audio')) throw new Error('Pick a video or audio source from media_list')
          if (media.meta.hasAudio === false) throw new Error('Source has no audio track')
          const end = a.end ?? media.meta.duration
          const range = a.start !== undefined || a.end !== undefined ? { start: a.start ?? 0, end: end! } : undefined
          if (range && !(range.end > range.start)) throw new Error('end must be after start (source flicks)')
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
          if (a.mediaId) {
            const { index, names } = await this.sourceTranscript(a.mediaId)
            return text(formatTranscript(index, { legend: SOURCE_LEGEND, fps: app.fps(), view: a.view, start: a.start, end: a.end, maxLines: a.maxLines, ...names }))
          }
          const index = buildIndex(app.project(), await this.loadAnalyses(), (c) => app.edit.timeMap(c))
          return text(formatTranscript(index, { fps: app.fps(), view: a.view, start: a.start, end: a.end, clipId: a.clipId && ids.resolve(a.clipId), maxLines: a.maxLines, ...this.transcriptIds() }))
        }
        case 'transcript_search': {
          const source = a.mediaId ? await this.sourceTranscript(a.mediaId) : undefined
          const index: TIndex = source?.index ?? buildIndex(app.project(), await this.loadAnalyses(), (c) => app.edit.timeMap(c))
          const hits = searchTranscript(index, a.query, a.regex)
          const t = source?.names ?? this.transcriptIds(), tc = (v: number) => formatTimecode(v, app.fps())
          if (!hits.length) return text(index.words.length ? 'No matches.' : 'No transcript yet. Run media_analyze on the sources first.')
          return text(hits.slice(0, 100).map(h => { const w = h.sentence.words; return `${t.sentenceId(h.sentence)} ${t.wordId(w[h.from])}${h.to > h.from ? `–${t.wordId(w[h.to])}` : ''} ${tc(w[h.from].start)}–${tc(w[h.to].end)} ${w.map((x, i) => `${i === h.from ? '«' : ''}${x.text}${i === h.to ? '»' : ''}`).join(' ')}` }).join('\n') + (hits.length > 100 ? `\n… ${hits.length - 100} more` : ''))
        }
        case 'audio_check': return text(await this.audioCheck(a))
        case 'captions_generate': {
          const captions = app.services.get('captions') as CaptionsService | undefined
          if (!captions) throw new Error('The captions plugin is not active')
          if (!a.clipId === !a.mediaId) throw new Error('Give exactly one of clipId (from timeline_get) or mediaId (from media_list)')
          if ([...this.captionJobs.values()].some(j => j.state === 'running')) throw new Error('A captions job is already running; poll job_get')
          const jobId = `captions-${this.captionJobs.size + 1}`
          const job: CaptionJob = { jobId, state: 'running', phase: 'starting', progress: 0, message: 'Starting' }
          this.captionJobs.set(jobId, job)
          const off = host.transcribe.onProgress(p => { if (job.state === 'running') Object.assign(job, { phase: p.phase, progress: Math.round(p.progress * 100) / 100, message: p.message }) })
          captions.generate({ clipId: a.clipId && ids.resolve(a.clipId), mediaId: a.mediaId && ids.resolve(a.mediaId), language: a.language })
            .then(clipIds => Object.assign(job, clipIds.length
              ? { state: 'done', progress: 1, message: `Created ${clipIds.length} caption clips on a new Captions track; inspect timeline_get`, clips: clipIds.length }
              : { state: 'done', progress: 1, message: 'No captions created (no speech found, or the user declined the model download)', clips: 0 }))
            .catch(error => Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) }))
            .finally(off)
          return text({ jobId, next: 'Poll job_get. The first run may wait on a model download prompt in the editor.' })
        }
      }
      throw new Error('Tool not implemented')
    } catch (error) { return { isError: true, content: [{ type: 'text', text: `${error instanceof Error ? error.message : String(error)}\nRecovery: inspect project_get, timeline_get or registry_list, correct the arguments, then retry.` }] } }
  }
  /** A source's transcript (source time) with source-anchor ids m1:w12 / m1:s3. */
  private async sourceTranscript(value: string) {
    const media = this.app.project().media[this.ids.resolve(value)]
    if (!media?.path) throw new Error('Pick a file-backed source from media_list')
    await this.loadAnalyses()
    const index = buildSourceIndex(media.id, this.analyses.get(media.path))
    if (!index.words.length && !index.shots.length && !index.events.length) throw new Error(`No analysis for ${value}; run media_analyze first`)
    const alias = this.ids.show(media.id, 'm')
    const names = { wordId: (w: TWord) => `${alias}:w${index.wordNo.get(w)}`, sentenceId: (s: TSentence) => `${alias}:s${index.sentenceNo.get(s)}`, clipLabel: () => '', trackLabel: () => '' }
    return { index, names }
  }

  /** Start an audio check job: render the range's mix through the WAV exporter, then measure (and transcribe) it. */
  private async audioCheck(a: Record<string, any>) {
    const app = this.app, host = app.host!, ids = this.ids
    const at = async (v: number | string | undefined, fallback: number) => typeof v === 'string' ? resolveAnchor(app.project(), await this.loadAnalyses(), ids, v, (c) => app.edit.timeMap(c)) : v ?? fallback
    const start = await at(a.start, 0), end = await at(a.end, app.duration())
    if (end <= start) throw new Error('audio_check needs end after start, within the timeline')
    if (end - start > 600 * FLICKS) throw new Error('audio_check covers at most 10 minutes; pass start/end')
    const tl = app.timeline()
    const clips = tl.tracks.filter(t => t.kind === 'audio' && !t.muted).flatMap(t => t.clips.filter(c => c.start < end && clipEnd(c) > start))
    if (!clips.length) throw new Error('No audible clips in this range (audio tracks only; muted tracks are skipped)')
    if ([...this.captionJobs.values()].some(j => j.state === 'running') || [...this.jobs.values()].some(j => !TERMINAL.includes(j.state))) throw new Error('Another export/analysis job is running; wait for it with job_get')
    const jobId = `audio-check-${this.captionJobs.size + 1}`
    const job: CaptionJob = { jobId, state: 'running', phase: 'render', progress: 0, message: 'Rendering the mix' }
    this.captionJobs.set(jobId, job)
    const project = app.project()
    const run = async () => {
      const output = `${(await host.info()).paths.userData}/audio-check.wav`
      const exportId = await host.export.start(await prepareExportRequest(app, { exporter: 'wav', output, range: { start, end } }))
      for (;;) {
        const p = this.jobs.get(exportId)
        if (p?.state === 'done') break
        if (p && TERMINAL.includes(p.state)) throw new Error(`Rendering failed: ${p.message ?? p.state}`)
        await sleep(200)
      }
      Object.assign(job, { phase: 'measure', progress: 0.5, message: 'Measuring' })
      const seconds = (end - start) / FLICKS
      const pcm = await host.media.pcm(output, 0, seconds, 48000)
      if (!pcm) throw new Error('Could not decode the rendered mix')
      const meter = new LoudnessMeter(new Float32Array(await (await fetch(pcm.url)).arrayBuffer()), pcm.sampleRate)
      const tc = (t: Flicks) => formatTimecode(t, project.settings.fps)
      const at = (s: number) => tc(start + Math.round(s * FLICKS))
      const show = (r: LoudnessReading) => `peak ${formatDb(r.peak)} dBFS, ${formatDb(r.integrated)} LUFS (max momentary ${formatDb(r.momentaryMax)})${r.clipped ? `, CLIPPING: ${r.clipped} samples at ${r.clipTimes.map(at).join(', ')}` : ''}`
      const all = meter.measure()
      const lines = [`Rendered mix ${tc(start)}–${tc(end)} (as exported): ${show(all)}`]
      if (all.peak > -1) lines.push('Warning: peaks above -1 dBFS distort on lossy encodes; lower the loudest clips.')
      lines.push('Per clip (the mix while it plays; overlapping clips share it):')
      for (const c of clips) {
        const from = Math.max(start, c.start), to = Math.min(end, clipEnd(c))
        const volume = c.properties.find(p => p.type === 'volume')
        lines.push(`  ${ids.show(c.id, 'c')} ${tc(from)}–${tc(to)} ${JSON.stringify(c.name)}${volume?.params.gain ? ` volume ${volume.params.gain.keyframes?.length ? 'keyframed' : `${volume.params.gain.value} dB`}` : ''}: ${show(meter.measure((from - start) / FLICKS, (to - start) / FLICKS))}`)
      }
      if (a.transcribe) {
        const bridge = host.analysis
        const status = bridge && await bridge.status()
        if (!bridge || !status?.available.includes('speech')) lines.push('Transcript: speech model unavailable; run media_analyze once to install it.')
        else {
          Object.assign(job, { phase: 'transcribe', progress: 0.7, message: 'Transcribing the rendered mix' })
          const heard = await bridge.run(output, { parts: ['speech'] })
          lines.push(`Heard (timeline time, ${heard.words.length} words; transcribed from the render, so cut-off or garbled words show up as such):`)
          for (const s of heard.sentences) lines.push(`  ${at(s.start / FLICKS)}–${at(s.end / FLICKS)} ${heard.words.slice(s.words[0], s.words[1]).map(w => `${w.text}${w.p < 0.4 ? '?' : ''}`).join(' ')}`)
          if (!heard.sentences.length) lines.push('  (no speech recognized)')
        }
      }
      return lines.join('\n')
    }
    run().then(report => Object.assign(job, { state: 'done', progress: 1, message: 'Done; the report follows', report }))
      .catch(error => Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) }))
    return { jobId, next: 'job_get with wait (e.g. wait=60) returns the report when done.' }
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
    ctx.track(ctx.app.doc.onChange.on(e => { handlers.history.push({ label: e.label, source: e.source }); if (handlers.history.length > 100) handlers.history.shift() }))
    ctx.track({ dispose: ctx.app.host.export.onProgress(p => { handlers.jobs.set(p.jobId, p) }) })
  }
})
