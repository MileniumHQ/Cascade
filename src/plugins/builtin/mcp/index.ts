import { definePlugin } from '@core/plugin-api'
import { prepareExportRequest } from '../export-request'
import { CascadeApp, type CascadeAPI } from '@core/app'
import type { Session } from '../../../renderer/app/session'
import type { PluginHost } from '@core/plugin-host'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ExportProgress, McpCall } from '@shared/ipc'
import { formatTimecode, FLICKS } from '@shared/time'
import { tools } from '../../../main/mcp/catalog'
import { Ids, applyEdits, resolveAnchor, staging, commit } from './edits'
import { frame, imageResult, sheet } from './images'
import { pluginDocs } from './plugin-docs'
import type { CaptionsService } from '../captions'
import type { SourceAnalysis } from '@shared/analysis'
import { buildIndex, formatTranscript, searchTranscript, type Analyses, type TWord, type TSentence } from './transcript'

interface CaptionJob { jobId: string; state: 'running' | 'done' | 'error'; phase: string; progress: number; message: string; clips?: number }

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
export class AgentTools {
  readonly ids = new Ids()
  readonly jobs = new Map<string, ExportProgress>()
  readonly captionJobs = new Map<string, CaptionJob>()
  readonly analyses: Analyses = new Map()
  readonly history: { label: string; source: string }[] = []
  constructor(readonly app: CascadeAPI) {}
  private session() {
    const session = this.app.services.get('session') as Session | undefined
    if (!session) throw new Error('Editor session is still starting. Retry shortly.')
    return session
  }
  private projectRequired() { if (this.session().screen() !== 'editor') throw new Error('No project open. Use project_new(name) or project_open(path).') }
  private async path(value: string): Promise<string> {
    if (value.startsWith('~/')) return `${(await this.app.host!.info()).paths.home}/${value.slice(2)}`
    if (!value.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(value)) throw new Error('Use an absolute path (or ~/path)')
    return value
  }
  private timeline() {
    const app = this.app, ids = this.ids
    const lines = [`${app.timeline().name} | duration ${formatTimecode(app.duration(), app.fps())} | times in flicks; 1s=${FLICKS}`]
    for (const tr of app.timeline().tracks) {
      lines.push(`${ids.show(tr.id, 't')} ${tr.name} [${tr.kind}${tr.locked ? ',locked' : ''}]`)
      for (const c of tr.clips) lines.push(`  ${ids.show(c.id, 'c')} ${formatTimecode(c.start, app.fps())}–${formatTimecode(c.start + c.duration, app.fps())} ${c.type} ${JSON.stringify(c.name)}${c.mediaId ? ` source=${ids.show(c.mediaId, 'm')}` : ''} | ${c.properties.map(p => `${ids.show(p.id, 'p')}:${p.type}{${Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v.value)}${v.keyframes?.length ? ` [${v.keyframes.length} keys]` : ''}`).join(',')}}`).join(' ')}`)
    }
    for (const m of app.timeline().markers) lines.push(`marker ${ids.show(m.id, 'k')} ${formatTimecode(m.t, app.fps())} ${JSON.stringify(m.name)}`)
    return lines.join('\n')
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
        case 'project_get': return text(a.detail === 'detailed' ? app.project() : { name: app.project().name, path: this.session().path(), settings: app.project().settings, duration: app.duration(), timecode: formatTimecode(app.duration(), app.fps()), media: app.project().mediaOrder.length, tracks: app.timeline().tracks.map(t => ({ id: ids.show(t.id, 't'), name: t.name, kind: t.kind, locked: t.locked })) })
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
            const mt = copy.edit.mediaTypeFor({ path, name: path.split('/').pop()!, ext: path.split('.').pop()!.toLowerCase(), meta })
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
          const index = buildIndex(app.project(), await this.loadAnalyses())
          const hint = index.words.length ? `transcript: ${index.words.length} words, ${index.events.length} sound events, ${index.shots.length} shot cuts on the timeline; read with transcript_get`
            : index.unanalyzed.length ? `transcript: none; media_analyze ${[...new Set(index.unanalyzed.map(u => ids.show(u.clip.mediaId!, 'm')))].join(', ')} to edit by words, intonation, sound events and shots` : ''
          const body = a.detail === 'detailed' ? `${this.timeline()}\n${JSON.stringify(app.timeline())}` : this.timeline()
          return text(hint ? `${body}\n${hint}` : body)
        }
        case 'timeline_apply_edits': return text(applyEdits(app, a, ids, await this.loadAnalyses()))
        case 'timeline_undo': return text(app.doc.undo() ? 'Undone' : 'Nothing to undo')
        case 'timeline_redo': return text(app.doc.redo() ? 'Redone' : 'Nothing to redo')
        case 'history_get': return text({ canUndo: app.doc.canUndo, undo: app.doc.undoLabel, canRedo: app.doc.canRedo, redo: app.doc.redoLabel, recentEvents: this.history.slice(-30) })
        case 'registry_list': {
          const r = app.registries
          return text({ mediaTypes: r.mediaTypes.all().map(({ id, name, track, extensions, defaultProperties }) => ({ id, name, track, extensions, defaultProperties })), properties: r.properties.all().map(({ id, name, description, params, appliesTo, stackable }) => ({ id, name, description, params, appliesTo: Array.isArray(appliesTo) ? appliesTo : 'predicate/default; validated when adding', stackable })), easings: r.easings.all().map(({ id, name, params }) => ({ id, name, params })), generators: r.generators.all().map(({ id, name, mediaType }) => ({ id, name, mediaType })), exporters: r.exporters.all().map(({ id, name, extension, options }) => ({ id, name, extension, options })) })
        }
        case 'frame_get': {
          const t = typeof a.time === 'string' ? resolveAnchor(app.project(), await this.loadAnalyses(), ids, a.time) : a.time
          return imageResult(await frame(app, t, a.width), `${typeof a.time === 'string' ? `${a.time} = ` : ''}${formatTimecode(t, app.fps())}`)
        }
        case 'contact_sheet': return await sheet(app, a)
        case 'timeline_preview_sheet': return await sheet(app, { ...a, start: 0, end: app.duration() })
        case 'media_contact_sheet': { const m = app.project().media[ids.resolve(a.mediaId)]; if (!m?.path) throw new Error('Select file-backed media from media_list'); if (!m.meta.hasVideo && m.type !== 'image') throw new Error('Source has no visual frames'); return await sheet(app, a, { path: m.path, duration: m.meta.duration ?? FLICKS, width: m.meta.width, height: m.meta.height }) }
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
          return text({ jobId, next: 'Poll job_get' })
        }
        case 'job_get': { const job = this.jobs.get(a.jobId) ?? this.captionJobs.get(a.jobId); if (!job) throw new Error('Unknown job; use a jobId from export_start in this editor session'); return text(job) }
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
            Object.assign(job, { state: 'done', progress: 1, message: `Analyzed ${result.words.length} words, ${result.sentences.length} sentences, ${result.events.length} sound events, ${result.shots.length} shot cuts (parts: ${result.parts.join(', ')}). Next: transcript_get.` })
          }).catch(error => Object.assign(job, { state: 'error', message: error instanceof Error ? error.message : String(error) })).finally(off)
          return text({ jobId, next: 'Poll job_get (about 2s per minute of speech), then transcript_get.' })
        }
        case 'transcript_get': {
          const index = buildIndex(app.project(), await this.loadAnalyses())
          return text(formatTranscript(index, { fps: app.fps(), view: a.view, start: a.start, end: a.end, clipId: a.clipId && ids.resolve(a.clipId), maxLines: a.maxLines, ...this.transcriptIds() }))
        }
        case 'transcript_search': {
          const index = buildIndex(app.project(), await this.loadAnalyses())
          const hits = searchTranscript(index, a.query, a.regex)
          const t = this.transcriptIds(), tc = (v: number) => formatTimecode(v, app.fps())
          if (!hits.length) return text(index.words.length ? 'No matches.' : 'No transcript yet. Run media_analyze on the sources first.')
          return text(hits.slice(0, 100).map(h => { const w = h.sentence.words; return `${t.sentenceId(h.sentence)} ${t.wordId(w[h.from])}${h.to > h.from ? `–${t.wordId(w[h.to])}` : ''} ${tc(w[h.from].start)}–${tc(w[h.to].end)} ${w.map((x, i) => `${i === h.from ? '«' : ''}${x.text}${i === h.to ? '»' : ''}`).join(' ')}` }).join('\n') + (hits.length > 100 ? `\n… ${hits.length - 100} more` : ''))
        }
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
