import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { ExporterContribution, PanelContext, ParamDef } from '@core/plugin-api'
import type { ExportProgress } from '@shared/ipc'
import { FPS_PRESETS, fpsKey, RESOLUTION_PRESETS } from '@shared/formats'
import { FLICKS, formatTimecode, type FrameRate } from '@shared/time'
import { Icon } from '@ui/icon'
import { Button, IconButton, NumberField, pushToast, Segmented, Select, TextField, Toggle } from '@ui/kit'
import { useProject, useRegistry, useValue } from '@ui/reactive'
import { prepareExportRequest, rangeHasAudio } from '../../export-request'
import { listPresets, presetMatches, presetPrefs, sanitizeUserPresets, snapshotPreset, uniquePresetId, USER_PRESETS_SETTING, type ExportState, type ListedPreset } from './presets'

type RangeMode = 'all' | 'inout'
interface Prefs {
  exporter: string
  options: Record<string, Record<string, unknown>>
  resolution: string
  fps: string
  dir?: string
}
interface Job {
  id: string
  output: string
  started: number
  finished?: number
  rangeSeconds: number
  progress: ExportProgress
}

const PREFS_KEY = 'cascade.export.prefs'
const loadPrefs = (): Prefs => {
  try {
    return { exporter: 'mp4-h264', options: {}, resolution: 'project', fps: 'project', ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return { exporter: 'mp4-h264', options: {}, resolution: 'project', fps: 'project' }
  }
}

const STATE_LABEL: Record<ExportProgress['state'], string> = {
  preparing: 'Preparing',
  rendering: 'Rendering frames',
  audio: 'Mixing audio',
  encoding: 'Encoding',
  muxing: 'Finishing file',
  finalizing: 'Finishing file',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled'
}

const kindOf = (e: ExporterContribution) => (e.video ? (e.id.includes('png') || e.id.includes('gif') ? 'Image' : 'Video') : 'Audio')
const iconOf = (e: ExporterContribution) => e.icon ?? (kindOf(e) === 'Audio' ? 'audio-lines' : kindOf(e) === 'Image' ? 'images' : 'film')

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const join = (dir: string, name: string) => `${dir.replace(/[\\/]$/, '')}/${name}`
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled'

const fmtDuration = (s: number) => {
  if (!Number.isFinite(s)) return '—'
  s = Math.max(0, Math.round(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export function ExportPanel(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const project = useProject(app)
  const exporters = useRegistry(app.registries.exporters)
  const contributedPresets = useRegistry(app.registries.exportPresets)
  const settingValues = useValue(app.settings.values)
  const [prefs, setPrefsRaw] = createSignal<Prefs>(loadPrefs())
  const setPrefs = (p: Partial<Prefs>) => {
    const next = { ...prefs(), ...p }
    setPrefsRaw(next)
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  }
  const [rangeMode, setRangeMode] = createSignal<RangeMode>('all')
  const [custom, setCustom] = createSignal({ w: 1920, h: 1080 })
  const [outputOverride, setOutputOverride] = createSignal<string | null>(null)
  const [docsDir, setDocsDir] = createSignal('')
  const [jobs, setJobs] = createSignal<Job[]>([])
  const [starting, setStarting] = createSignal(false)

  const exporter = createMemo(() => exporters().find((e) => e.id === prefs().exporter) ?? exporters()[0])
  const groups = createMemo(() => {
    const g = new Map<string, ExporterContribution[]>()
    for (const e of exporters()) g.set(kindOf(e), [...(g.get(kindOf(e)) ?? []), e])
    return [...g.entries()].sort((a, b) => ['Video', 'Image', 'Audio'].indexOf(a[0]) - ['Video', 'Image', 'Audio'].indexOf(b[0]))
  })
  const options = createMemo(() => {
    const e = exporter()
    if (!e) return {}
    return { ...Object.fromEntries(e.options.map((p) => [p.id, p.default])), ...prefs().options[e.id] }
  })
  const setOption = (id: string, v: unknown) => {
    const e = exporter()
    if (!e) return
    setPrefs({ options: { ...prefs().options, [e.id]: { ...prefs().options[e.id], [id]: v } } })
  }

  const tl = () => project().timelines[project().activeTimeline]
  const hasInOut = () => tl()?.inPoint !== undefined || tl()?.outPoint !== undefined
  const range = createMemo(() => {
    project() // app.duration() isn't reactive; track edits (MCP, undo, open) through the project
    const dur = app.duration()
    if (rangeMode() === 'inout' && hasInOut()) return { start: tl()!.inPoint ?? 0, end: tl()!.outPoint ?? dur }
    return { start: 0, end: dur }
  })
  const size = createMemo(() => {
    const s = project().settings
    const r = prefs().resolution
    if (r === 'project') return { w: s.width, h: s.height }
    if (r === 'custom') return custom()
    const p = RESOLUTION_PRESETS.find((x) => x.id === r)
    return p ? { w: p.w, h: p.h } : { w: s.width, h: s.height }
  })
  const fps = createMemo<FrameRate>(() => (prefs().fps === 'project' ? project().settings.fps : FPS_PRESETS.find((p) => p.value === prefs().fps)?.fps ?? project().settings.fps))
  const frames = () => Math.ceil(((range().end - range().start) * fps().num) / (FLICKS * fps().den))
  const seconds = () => (range().end - range().start) / FLICKS

  const session = () => app.services.get('session') as { path(): string | null } | undefined
  const output = createMemo(() => {
    const e = exporter()
    if (outputOverride()) return outputOverride()!
    const dir = prefs().dir ?? (session()?.path() ? dirname(session()!.path()!) : docsDir())
    const base = safeName(project().name)
    return e?.extension === 'png' ? join(dir, `${base} frames`) : join(dir, `${base}.${e?.extension ?? 'mp4'}`)
  })
  // Keep a chosen file's folder but follow the format's extension.
  const changeExporter = (id: string) => {
    const e = exporters().find((x) => x.id === id)
    setPrefs({ exporter: id })
    const o = outputOverride()
    if (o && e) setOutputOverride(e.extension === 'png' ? o.replace(/\.[^./\\]+$/, '') + ' frames' : o.replace(/( frames)?(\.[^./\\]+)?$/, `.${e.extension}`))
  }

  // ── presets ──
  const userPresets = createMemo(() => sanitizeUserPresets(settingValues()[USER_PRESETS_SETTING]))
  const presets = createMemo(() => listPresets(contributedPresets(), userPresets(), (id) => exporters().some((e) => e.id === id)))
  const exportState = createMemo<ExportState>(() => ({
    exporter: exporter()?.id ?? '',
    options: options(),
    size: size(),
    sizeIsProject: prefs().resolution === 'project',
    fps: fps(),
    fpsIsProject: prefs().fps === 'project',
    range: hasInOut() ? rangeMode() : 'all'
  }))
  const currentPreset = createMemo(() => presets().find((p) => presetMatches(p, exportState())))
  const [naming, setNaming] = createSignal<{ mode: 'new' | 'rename'; value: string } | null>(null)
  const saveUserPresets = (list: ReturnType<typeof userPresets>) => app.settings.set(USER_PRESETS_SETTING, list)

  const applyPreset = (preset: ListedPreset) => {
    const patch = presetPrefs(preset)
    changeExporter(patch.exporter)
    setPrefs({
      options: { ...prefs().options, [patch.exporter]: patch.options },
      resolution: patch.resolution ?? 'project',
      fps: patch.fps ?? (preset.fps ? prefs().fps : 'project')
    })
    if (patch.custom) setCustom(patch.custom)
    if (patch.range) setRangeMode(patch.range === 'inout' && !hasInOut() ? 'all' : patch.range)
  }
  const commitName = () => {
    const n = naming()
    const name = n?.value.trim()
    if (!n || !name) return setNaming(null)
    const list = userPresets()
    if (n.mode === 'rename' && currentPreset()?.user) saveUserPresets(list.map((p) => (p.id === currentPreset()!.id ? { ...p, name } : p)))
    else saveUserPresets([...list, snapshotPreset(name, exportState(), uniquePresetId(name, [...list, ...contributedPresets()].map((p) => p.id)))])
    setNaming(null)
  }
  const deletePreset = () => {
    const p = currentPreset()
    if (p?.user) saveUserPresets(userPresets().filter((u) => u.id !== p.id))
  }

  const active = () => jobs().find((j) => !['done', 'error', 'cancelled'].includes(j.progress.state))

  onMount(() => {
    void app.host?.info().then((i) => setDocsDir(join(i.paths.documents, 'Cascade Exports')))
    const off = app.host?.export.onProgress((p) => {
      const terminal = ['done', 'error', 'cancelled'].includes(p.state)
      setJobs((js) => js.map((j) => (j.id === p.jobId ? { ...j, progress: p, finished: terminal ? (j.finished ?? Date.now()) : undefined } : j)))
      if (p.state === 'done') pushToast({ id: Date.now(), kind: 'success', message: 'Export finished', detail: p.output })
      if (p.state === 'error') pushToast({ id: Date.now(), kind: 'error', message: 'Export failed', detail: p.message })
    })
    onCleanup(() => off?.())
  })

  const browse = async () => {
    const e = exporter()
    if (!e || !app.host) return
    if (e.extension === 'png') {
      const [dir] = await app.host.dialog.openFiles({ title: 'Choose a folder for the frames', directory: true })
      if (dir) setOutputOverride(join(dir, `${safeName(project().name)} frames`))
      return
    }
    const p = await app.host.dialog.saveFile({ title: 'Export to', defaultPath: output(), filters: [{ name: e.name, extensions: [e.extension] }] })
    if (p) {
      setOutputOverride(p)
      setPrefs({ dir: dirname(p) })
    }
  }

  const start = async () => {
    const e = exporter()
    if (!e || !app.host || active()) return
    if (range().end <= range().start) {
      pushToast({ id: Date.now(), kind: 'error', message: 'Nothing to export', detail: 'Add clips to the timeline first.' })
      return
    }
    setStarting(true)
    try {
      const req = await prepareExportRequest(app, { exporter: e.id, output: output(), options: options(), width: size().w, height: size().h, fps: fps(), range: range() })
      const id = await app.host.export.start(req)
      const job: Job = { id, output: req.output, started: Date.now(), rangeSeconds: seconds(), progress: { jobId: id, state: 'preparing', framesDone: 0, framesTotal: frames(), fps: 0 } }
      setJobs((js) => [job, ...js.filter((j) => j.id !== id)].slice(0, 6))
    } catch (err) {
      pushToast({ id: Date.now(), kind: 'error', message: 'Export failed to start', detail: String(err) })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div class="ex">
      <section class="ex-formats">
        <For each={groups()}>
          {([group, list]) => (
            <>
              <div class="ex-group">{group}</div>
              <For each={list}>
                {(e) => (
                  <button class={`ex-format ${exporter()?.id === e.id ? 'on' : ''}`} onClick={() => changeExporter(e.id)}>
                    <Icon name={iconOf(e)} size={15} />
                    <span class="ex-format-text">
                      <span class="ex-format-name">{e.name}</span>
                      <span class="ex-format-desc">{e.description}</span>
                    </span>
                    <span class="ex-ext">.{e.extension}</span>
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </section>

      <section class="ex-settings">
        <div class="ex-row ex-row-wide ex-presets">
          <label>Preset</label>
          <Show
            when={naming()}
            fallback={
              <div class="ex-inline">
                <Select
                  value={currentPreset()?.id ?? ''}
                  width="230px"
                  options={[{ value: '', label: 'Custom' }, ...presets().map((p) => ({ value: p.id, label: p.name, icon: p.icon }))]}
                  onChange={(id) => {
                    const p = presets().find((x) => x.id === id)
                    if (p) applyPreset(p)
                  }}
                />
                <IconButton icon="bookmark-plus" size="sm" tip="Save settings as a preset" onClick={() => setNaming({ mode: 'new', value: '' })} />
                <Show when={currentPreset()?.user}>
                  <IconButton icon="pencil" size="sm" tip="Rename preset" onClick={() => setNaming({ mode: 'rename', value: currentPreset()!.name })} />
                  <IconButton icon="trash-2" size="sm" tip="Delete preset" onClick={deletePreset} />
                </Show>
              </div>
            }
          >
            <div class="ex-inline">
              <TextField value={naming()!.value} placeholder="Preset name" autofocus onInput={(v) => setNaming({ ...naming()!, value: v })} onChange={(v) => setNaming({ ...naming()!, value: v })} class="ex-preset-name" />
              <Button size="sm" variant="primary" disabled={!naming()!.value.trim()} onClick={commitName}>
                Save
              </Button>
              <Button size="sm" onClick={() => setNaming(null)}>
                Cancel
              </Button>
            </div>
          </Show>
        </div>
        <div class="ex-row ex-row-wide">
          <label>Output</label>
          <div class="ex-output">
            <span class="ex-path" data-tip={output()}>
              <Icon name={exporter()?.extension === 'png' ? 'folder' : 'file-video'} size={13} />
              <span class="ex-path-dir">{dirname(output())}/</span>
              <span class="ex-path-name">{output().split(/[\\/]/).pop()}</span>
            </span>
            <Button size="sm" icon="folder-open" onClick={() => void browse()}>
              Change…
            </Button>
          </div>
        </div>
        <Show when={exporter()?.video}>
          <div class="ex-row">
            <label>Resolution</label>
            <div class="ex-inline">
              <Select
                value={prefs().resolution}
                width="180px"
                options={[
                  { value: 'project', label: `Project · ${project().settings.width}×${project().settings.height}` },
                  ...RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.w}×${p.h}` })),
                  { value: 'custom', label: 'Custom' }
                ]}
                onChange={(v) => setPrefs({ resolution: v })}
              />
              <Show when={prefs().resolution === 'custom'}>
                <NumberField value={custom().w} min={2} max={16384} step={2} width="74px" suffix="w" onChange={(v) => setCustom({ ...custom(), w: Math.round(v / 2) * 2 })} />
                <NumberField value={custom().h} min={2} max={16384} step={2} width="74px" suffix="h" onChange={(v) => setCustom({ ...custom(), h: Math.round(v / 2) * 2 })} />
              </Show>
            </div>
          </div>
          <div class="ex-row">
            <label>Frame rate</label>
            <Select
              value={prefs().fps}
              width="180px"
              options={[{ value: 'project', label: `Project · ${fpsKey(project().settings.fps)} fps` }, ...FPS_PRESETS.map((p) => ({ value: p.value, label: `${p.label} fps` }))]}
              onChange={(v) => setPrefs({ fps: v })}
            />
          </div>
        </Show>
        <div class="ex-row">
          <label>Range</label>
          <Segmented
            value={hasInOut() ? rangeMode() : 'all'}
            options={[
              { value: 'all', label: 'Whole timeline' },
              { value: 'inout', label: 'In → Out', tip: hasInOut() ? 'Between the in and out points' : 'Set in/out points with I and O' }
            ]}
            onChange={(v) => hasInOut() && setRangeMode(v as RangeMode)}
          />
        </div>
        <For each={exporter()?.options ?? []}>{(def) => <OptionRow def={def} value={options()[def.id]} onChange={(v) => setOption(def.id, v)} />}</For>
      </section>

      <section class="ex-side">
        <div class="ex-summary">
          <div class="ex-summary-title">
            <Icon name={exporter() ? iconOf(exporter()!) : 'film'} size={16} />
            {exporter()?.name ?? 'No format'}
          </div>
          <div class="ex-facts tnum">
            <Show when={exporter()?.video}>
              <span>
                {size().w}×{size().h}
              </span>
              <span>{fpsKey(fps())} fps</span>
            </Show>
            <span>{formatTimecode(range().end - range().start, fps())}</span>
            <Show when={exporter()?.video}>
              <span>{frames().toLocaleString()} frames</span>
            </Show>
            <Show when={exporter()?.audio}>
              <span>{rangeHasAudio(app, range()) ? 'with audio' : 'no audio'}</span>
            </Show>
          </div>
        </div>
        <Button variant="primary" icon="clapperboard" class="ex-go" disabled={!!active() || starting() || !exporter()} onClick={() => void start()} kbd="Mod+E">
          {active() ? 'Exporting…' : 'Export'}
        </Button>
        <div class="ex-jobs">
          <For each={jobs()}>{(j) => <JobCard app={app} job={j} />}</For>
        </div>
      </section>
    </div>
  )
}

function OptionRow(props: { def: ParamDef; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <div class="ex-row">
      <label>{props.def.label}</label>
      <Switch fallback={<span class="ex-dim">—</span>}>
        <Match when={props.def.type === 'toggle'}>
          <Toggle value={!!props.value} onChange={props.onChange} />
        </Match>
        <Match when={props.def.type === 'select'}>
          <Select value={String(props.value)} width="180px" options={props.def.options ?? []} onChange={props.onChange} />
        </Match>
        <Match when={props.def.type === 'number'}>
          <NumberField value={Number(props.value)} min={props.def.min} max={props.def.max} step={props.def.step ?? 1} width="110px" onChange={(v) => props.onChange(v)} />
        </Match>
      </Switch>
    </div>
  )
}

function JobCard(props: { app: CascadeAPI; job: Job }) {
  const p = () => props.job.progress
  const pct = () => (p().framesTotal ? Math.min(1, p().framesDone / p().framesTotal) : 0)
  const running = () => !['done', 'error', 'cancelled'].includes(p().state)
  const elapsed = () => ((props.job.finished ?? Date.now()) - props.job.started) / 1000
  const name = () => props.job.output.split(/[\\/]/).pop()
  return (
    <div class={`ex-job state-${p().state}`}>
      <div class="ex-job-head">
        <span class="ex-job-name" data-tip={props.job.output}>
          {name()}
        </span>
        <span class="ex-job-state">{STATE_LABEL[p().state]}</span>
      </div>
      <Show when={running()}>
        <div class="ex-bar">
          <i style={{ width: `${pct() * 100}%` }} />
        </div>
        <div class="ex-job-meta tnum">
          <span>
            {p().framesDone.toLocaleString()} / {p().framesTotal.toLocaleString()}
          </span>
          <Show when={p().fps}>
            <span>{Math.round(p().fps)} fps</span>
          </Show>
          <Show when={p().etaSeconds !== undefined}>
            <span>{fmtDuration(p().etaSeconds!)} left</span>
          </Show>
          <button class="ex-cancel" data-tip="Cancel export" onClick={() => void props.app.host?.export.cancel(props.job.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      </Show>
      <Show when={p().state === 'done'}>
        <div class="ex-job-meta tnum">
          <span>{fmtDuration(elapsed())}</span>
          <span>{(props.job.rangeSeconds / Math.max(0.001, elapsed())).toFixed(1)}× realtime</span>
          <button class="ex-reveal" onClick={() => props.app.host?.shell.showItemInFolder(p().output ?? props.job.output)}>
            <Icon name="folder-open" size={12} /> Show
          </button>
        </div>
      </Show>
      <Show when={p().state === 'error'}>
        <div class="ex-job-error">{p().message}</div>
      </Show>
    </div>
  )
}
