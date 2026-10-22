import { createProject, timelineDuration, type Id, type Project, type Timeline, type TrackKind } from '@shared/project'
import type { HostBridge } from '@shared/ipc'
import { FLICKS, frameToFlicks, flicksToFrame, snapToFrame, type Flicks, type FrameRate } from '@shared/time'
import { DocumentStore } from './document'
import { EventBus, Emitter } from './events'
import { Registry } from './registry'
import { Value, shallowArrayEqual } from './value'
import type {
  CommandContribution,
  EasingContribution,
  ExporterContribution,
  ExportPresetContribution,
  GeneratorContribution,
  KeybindingContribution,
  MediaTypeContribution,
  MenuItemContribution,
  OverlayContribution,
  PanelContribution,
  PresetContribution,
  ParamTypeContribution,
  PluginEnv,
  PropertyContribution,
  SettingContribution,
  StatusItemContribution,
  TransitionContribution,
  TimelineToolContribution
} from './plugin-api'
import { Editing } from './editing'
import { MediaStatusService } from './media-status'
import { MeterService } from './meters'
import { ClipboardService, type ClipboardFormatContribution } from './clipboard'
import type { MarkerKindContribution } from './plugin-api'

export interface Registries {
  markerKinds: Registry<MarkerKindContribution>
  clipboardFormats: Registry<ClipboardFormatContribution>
  mediaTypes: Registry<MediaTypeContribution>
  transitions: Registry<TransitionContribution>
  properties: Registry<PropertyContribution>
  paramTypes: Registry<ParamTypeContribution>
  easings: Registry<EasingContribution>
  panels: Registry<PanelContribution>
  overlays: Registry<OverlayContribution>
  commands: Registry<CommandContribution>
  keybindings: Registry<KeybindingContribution>
  menus: Registry<MenuItemContribution>
  statusItems: Registry<StatusItemContribution>
  settings: Registry<SettingContribution>
  exporters: Registry<ExporterContribution>
  generators: Registry<GeneratorContribution>
  exportPresets: Registry<ExportPresetContribution>
  presets: Registry<PresetContribution>
  timelineTools: Registry<TimelineToolContribution>
}

export const createRegistries = (): Registries => ({
  markerKinds: new Registry('markerKinds'),
  clipboardFormats: new Registry('clipboardFormats'),
  mediaTypes: new Registry('mediaTypes'),
  transitions: new Registry('transitions'),
  properties: new Registry('properties'),
  paramTypes: new Registry('paramTypes'),
  easings: new Registry('easings'),
  panels: new Registry('panels'),
  overlays: new Registry('overlays'),
  commands: new Registry('commands'),
  keybindings: new Registry('keybindings'),
  menus: new Registry('menus'),
  statusItems: new Registry('statusItems'),
  settings: new Registry('settings'),
  exporters: new Registry('exporters'),
  generators: new Registry('generators'),
  exportPresets: new Registry('exportPresets'),
  presets: new Registry('presets'),
  timelineTools: new Registry('timelineTools')
})

// ───────────────────────────── services ─────────────────────────────

/** Playhead + transport. The preview engine drives frames; anything can observe `time`. */
export class PlaybackService {
  readonly time = new Value<Flicks>(0)
  readonly playing = new Value(false)
  readonly rate = new Value(1)
  readonly loop = new Value(false)
  /** Measured preview frame rate & dropped frames (written by the preview). */
  readonly stats = new Value({ fps: 0, dropped: 0 })
  private raf = 0
  private anchor = { wall: 0, t: 0 }
  /** External clock (e.g. AudioContext time) in seconds; preferred when set. */
  clock: (() => number) | null = null

  constructor(private app: { duration(): Flicks; fps(): FrameRate }) {}

  private now() {
    return this.clock ? this.clock() : performance.now() / 1000
  }

  play() {
    if (this.playing.get()) return
    const end = this.app.duration()
    if (end > 0 && this.time.get() >= end - frameToFlicks(1, this.app.fps())) this.time.set(0)
    this.anchor = { wall: this.now(), t: this.time.get() }
    this.playing.set(true)
    const tick = () => {
      if (!this.playing.get()) return
      const elapsed = (this.now() - this.anchor.wall) * this.rate.get()
      let t = Math.round(this.anchor.t + elapsed * FLICKS)
      const endT = this.app.duration()
      if (t < 0) {
        t = 0
        this.pause()
      } else if (endT > 0 && t >= endT) {
        if (this.loop.get()) {
          t = 0
          this.anchor = { wall: this.now(), t: 0 }
        } else {
          t = endT
          this.time.set(t)
          this.pause()
          return
        }
      }
      this.time.set(t)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  pause() {
    if (!this.playing.get()) return
    cancelAnimationFrame(this.raf)
    this.playing.set(false)
    // land on a frame boundary
    this.time.set(snapToFrame(this.time.get(), this.app.fps()))
  }

  toggle() {
    if (this.playing.get()) this.pause()
    else this.play()
  }

  setRate(r: number) {
    this.anchor = { wall: this.now(), t: this.time.get() }
    this.rate.set(r)
  }

  seek(t: Flicks) {
    const clamped = Math.max(0, Math.round(t))
    this.anchor = { wall: this.now(), t: clamped }
    this.time.set(clamped)
  }

  stepFrames(n: number) {
    if (this.playing.get()) this.pause()
    const fps = this.app.fps()
    this.seek(frameToFlicks(flicksToFrame(this.time.get(), fps) + n, fps))
  }

  get frame() {
    return flicksToFrame(this.time.get(), this.app.fps())
  }
}

export interface KeyframeSelection {
  clipId: Id
  propertyId: Id
  paramId: string
  keyframeId: Id
}

export class SelectionService {
  readonly markers = new Value<Id[]>([], shallowArrayEqual)
  readonly transitions = new Value<Id[]>([], shallowArrayEqual)
  readonly clips = new Value<Id[]>([], shallowArrayEqual)
  readonly keyframes = new Value<KeyframeSelection[]>([], shallowArrayEqual)
  readonly media = new Value<Id[]>([], shallowArrayEqual)
  /** The track that receives pasted/inserted clips. */
  readonly track = new Value<Id | null>(null)
  /** Target track per kind for source edits (insert/overwrite/append); absent = the first unlocked track of that kind. */
  readonly targets = new Value<Partial<Record<TrackKind, Id>>>({})
  /** Property instance focused in the inspector (keyframe panel highlights it). */
  readonly property = new Value<Id | null>(null)

  constructor() {
    // Direct Value writes by existing panels/plugins obey the same selection exclusivity.
    this.clips.subscribe(ids => { if (ids.length) { this.transitions.set([]); this.markers.set([]) } })
    this.markers.subscribe(ids => { if (ids.length) { this.clips.set([]); this.transitions.set([]); this.media.set([]); this.keyframes.set([]) } })
    this.media.subscribe(ids => { if (ids.length) { this.transitions.set([]); this.markers.set([]) } })
  }

  get primaryClip(): Id | null {
    const c = this.clips.get()
    return c.length ? c[c.length - 1] : null
  }
  setMarkers(ids: Id[]) { this.markers.set(ids) }
  setTransitions(ids: Id[]) {
    if (ids.length) this.markers.set([])
    this.transitions.set(ids)
    if (ids.length) { this.clips.set([]); this.media.set([]); this.keyframes.set([]) }
  }
  setClips(ids: Id[]) {
    this.markers.set([])
    this.transitions.set([])
    this.clips.set(ids)
    if (ids.length) this.media.set([])
  }
}

/** Shared horizontal view of the timeline (Timeline & Keyframes panels stay in lockstep). */
export class TimelineViewService {
  readonly pxPerSecond = new Value(60)
  readonly scrollX = new Value(0)
  readonly snapping = new Value(true)
  /** Active timeline tool id; kept valid against the tool registry (see `ensureTool`). */
  readonly tool = new Value<string>('')
  /** Falls back to the best (highest-priority) contributed tool when the active one isn't registered. */
  ensureTool(tools: Registry<TimelineToolContribution>) {
    const current = this.tool.get()
    // An untouched default keeps following the registry as plugins activate one by one.
    if (tools.has(current) && current !== this.autoTool) return
    const first = tools.all()[0]
    if (!first) return
    this.autoTool = first.id
    this.tool.set(first.id)
  }
  private autoTool = ''
  /** Width of the visible lane area in px (set by the timeline). */
  readonly viewportWidth = new Value(800)
  timeToPx(t: Flicks) {
    return (t / FLICKS) * this.pxPerSecond.get()
  }
  pxToTime(px: number): Flicks {
    return Math.round((px / this.pxPerSecond.get()) * FLICKS)
  }
  zoomAround(factor: number, anchorPx: number) {
    const pps = this.pxPerSecond.get()
    const next = Math.min(4000, Math.max(0.02, pps * factor))
    const tAtAnchor = (this.scrollX.get() + anchorPx) / pps
    this.pxPerSecond.set(next)
    this.scrollX.set(Math.max(0, tAtAnchor * next - anchorPx))
  }
}

export interface LayoutConfig {
  sidePosition: 'left' | 'right'
  side: string[]
  top: string[]
  bottom: string[]
}

export class LayoutService {
  readonly config = new Value<LayoutConfig>({
    sidePosition: 'left',
    side: ['sources'],
    top: ['preview', 'inspector'],
    bottom: ['timeline', 'keyframes', 'export']
  })
  readonly activeBottom = new Value('timeline')
  readonly activeSide = new Value('sources')
  /** The shown panel of each tab group (see PanelContribution.group); absent = the group's first panel. */
  readonly activeTab = new Value<Record<string, string>>({})
  constructor(private panels: () => PanelContribution[] = () => []) {}
  /** Panels request focus/visibility via this. */
  reveal(panelId: string) {
    const cfg = this.config.get()
    if (cfg.bottom.includes(panelId)) this.activeBottom.set(panelId)
    if (cfg.side.includes(panelId)) this.activeSide.set(panelId)
    const group = this.panels().find((p) => p.id === panelId)?.group
    if (group) this.activeTab.set({ ...this.activeTab.get(), [group]: panelId })
  }
}

export class SettingsService {
  readonly values = new Value<Record<string, unknown>>({})
  constructor(private app: CascadeApp) {}
  get<T>(id: string): T {
    const v = this.values.get()[id]
    if (v !== undefined) return v as T
    return this.app.registries.settings.get(id)?.default as T
  }
  set(id: string, v: unknown) {
    this.values.set({ ...this.values.get(), [id]: v })
    void this.app.host?.settings.save(this.values.get())
  }
}

export interface Notification {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
}

// ───────────────────────────── the app ─────────────────────────────

export interface CascadeAPI {
  readonly env: PluginEnv
  readonly doc: DocumentStore
  readonly registries: Registries
  readonly playback: PlaybackService
  readonly selection: SelectionService
  readonly view: TimelineViewService
  readonly layout: LayoutService
  readonly settings: SettingsService
  readonly events: EventBus
  readonly clipboard: ClipboardService
  readonly edit: Editing
  /** Runtime state of file-backed media (offline files). */
  readonly media: MediaStatusService
  /** Audio level taps (mixer, status bar…). */
  readonly meters: MeterService
  readonly host: HostBridge | null
  /** Arbitrary named services contributed by plugins (e.g. "preview", "media"). */
  readonly services: Map<string, unknown>
  project(): Project
  timeline(): Timeline
  fps(): Project['settings']['fps']
  duration(): Flicks
  run(commandId: string, ...args: unknown[]): unknown
  notify(kind: Notification['kind'], message: string, detail?: string): void
}

export class CascadeApp implements CascadeAPI {
  readonly doc: DocumentStore
  readonly registries = createRegistries()
  readonly playback: PlaybackService
  readonly selection = new SelectionService()
  readonly view = new TimelineViewService()
  readonly layout = new LayoutService(() => this.registries.panels.all())
  readonly settings: SettingsService
  readonly events = new EventBus()
  readonly clipboard: ClipboardService
  readonly edit: Editing
  readonly media: MediaStatusService
  readonly meters = new MeterService()
  readonly services = new Map<string, unknown>()
  readonly onNotify = new Emitter<Notification>()
  private notifyId = 0

  constructor(
    readonly env: PluginEnv,
    readonly host: HostBridge | null,
    project: Project = createProject('Untitled')
  ) {
    this.doc = new DocumentStore(project)
    this.registries.timelineTools.onChange.on(() => this.view.ensureTool(this.registries.timelineTools))
    this.playback = new PlaybackService(this)
    this.settings = new SettingsService(this)
    this.edit = new Editing(this)
    this.media = new MediaStatusService(host, () => this.doc.state)
    // Re-check files when a project loads or its media list changes (import, relink, undo).
    let lastMedia = this.doc.state.media
    this.doc.onChange.on((e) => {
      if (e.source !== 'load' && this.doc.state.media === lastMedia) return
      lastMedia = this.doc.state.media
      if (e.source === 'load') this.media.offline.set(new Set())
      void this.media.check()
    })
    this.clipboard = new ClipboardService(this)
    // keep selection valid after edits/undo
    this.doc.onChange.on(() => {
      const tl = this.timeline()
      if (!tl) return
      const alive = new Set<Id>()
      for (const tr of tl.tracks) for (const c of tr.clips) alive.add(c.id)
      const markers = new Set([...tl.markers, ...tl.tracks.flatMap(tr => tr.clips.flatMap(c => c.markers ?? []))].map(m => m.id))
      const selectedMarkers = this.selection.markers.get()
      if (selectedMarkers.some(id => !markers.has(id))) this.selection.markers.set(selectedMarkers.filter(id => markers.has(id)))
      const transitions = new Set(tl.tracks.flatMap(tr => (tr.transitions ?? []).map(tx => tx.id)))
      const selected = this.selection.transitions.get()
      if (selected.some(id => !transitions.has(id))) this.selection.transitions.set(selected.filter(id => transitions.has(id)))
      const sel = this.selection.clips.get()
      if (sel.some((id) => !alive.has(id))) this.selection.clips.set(sel.filter((id) => alive.has(id)))
    })
  }

  project() {
    return this.doc.state
  }
  timeline(): Timeline {
    const p = this.doc.state
    return p.timelines[p.activeTimeline]
  }
  fps() {
    return this.doc.state.settings.fps
  }
  duration() {
    const tl = this.timeline()
    return tl ? timelineDuration(tl) : 0
  }
  run(commandId: string, ...args: unknown[]) {
    const cmd = this.registries.commands.get(commandId)
    if (!cmd) {
      console.warn(`[cascade] unknown command ${commandId}`)
      return undefined
    }
    if (cmd.enabled && !cmd.enabled(this)) return undefined
    try {
      return cmd.run(this, ...args)
    } catch (e) {
      this.notify('error', `${cmd.title} failed`, String(e))
      console.error(e)
      return undefined
    }
  }
  notify(kind: Notification['kind'], message: string, detail?: string) {
    this.onNotify.emit({ id: ++this.notifyId, kind, message, detail })
  }
}
