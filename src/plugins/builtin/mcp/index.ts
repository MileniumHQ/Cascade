import { definePlugin } from '@core/plugin-api'
import { CascadeApp, type CascadeAPI } from '@core/app'
import type { Session } from '../../../renderer/app/session'
import type { PluginHost } from '@core/plugin-host'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ExportProgress, McpCall } from '@shared/ipc'
import { formatTimecode, FLICKS } from '@shared/time'
import { tools } from '../../../main/mcp/catalog'
import { Ids, applyEdits, staging, commit } from './edits'
import { frame, imageResult, sheet } from './images'
import { pluginDocs } from './plugin-docs'

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
export class AgentTools {
  readonly ids = new Ids()
  readonly jobs = new Map<string, ExportProgress>()
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
  async call(call: McpCall): Promise<CallToolResult> {
    try {
      const def = tools.find(t => t.name === call.tool)
      if (!def) throw new Error(`Unknown tool ${call.tool}`)
      const a = def.schema.parse(call.args) as Record<string, any>
      const app = this.app, host = app.host!, ids = this.ids
      if (!['project_new', 'project_open', 'registry_list', 'plugin_api_docs', 'plugin_list', 'plugin_write', 'plugin_remove', 'captions_generate'].includes(call.tool)) this.projectRequired()
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
        case 'timeline_get': return text(a.detail === 'detailed' ? `${this.timeline()}\n${JSON.stringify(app.timeline())}` : this.timeline())
        case 'timeline_apply_edits': return text(applyEdits(app, a, ids))
        case 'timeline_undo': return text(app.doc.undo() ? 'Undone' : 'Nothing to undo')
        case 'timeline_redo': return text(app.doc.redo() ? 'Redone' : 'Nothing to redo')
        case 'history_get': return text({ canUndo: app.doc.canUndo, undo: app.doc.undoLabel, canRedo: app.doc.canRedo, redo: app.doc.redoLabel, recentEvents: this.history.slice(-30) })
        case 'registry_list': {
          const r = app.registries
          return text({ mediaTypes: r.mediaTypes.all().map(({ id, name, track, extensions, defaultProperties }) => ({ id, name, track, extensions, defaultProperties })), properties: r.properties.all().map(({ id, name, description, params, appliesTo, stackable }) => ({ id, name, description, params, appliesTo: Array.isArray(appliesTo) ? appliesTo : 'predicate/default; validated when adding', stackable })), easings: r.easings.all().map(({ id, name, params }) => ({ id, name, params })), generators: r.generators.all().map(({ id, name, mediaType }) => ({ id, name, mediaType })), exporters: r.exporters.all().map(({ id, name, extension, options }) => ({ id, name, extension, options })) })
        }
        case 'frame_get': return imageResult(await frame(app, a.time, a.width), formatTimecode(a.time, app.fps()))
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
          const jobId = await host.export.start({ project: app.project(), timelineId: app.project().activeTimeline, width: a.width ?? app.project().settings.width, height: a.height ?? app.project().settings.height, fps: app.fps(), range: { start, end }, exporter: a.exporter, output: await this.path(a.output), options: a.options })
          if (!this.jobs.has(jobId)) this.jobs.set(jobId, { jobId, state: 'preparing', framesDone: 0, framesTotal: 0, fps: 0 })
          return text({ jobId, next: 'Poll job_get' })
        }
        case 'job_get': { const job = this.jobs.get(a.jobId); if (!job) throw new Error('Unknown job; use a jobId from export_start in this editor session'); return text(job) }
        case 'export_cancel': if (!this.jobs.has(a.jobId)) throw new Error('Unknown job'); await host.export.cancel(a.jobId); return text('Cancellation requested')
        case 'captions_generate': return { isError: true, content: [{ type: 'text', text: 'Caption transcription is not yet available. Recovery: add manual text clips with timeline_apply_edits/add_text, or retry once the transcription service is installed.' }] }
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
