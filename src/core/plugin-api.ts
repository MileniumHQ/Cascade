/**
 * Cascade plugin API.
 *
 * Cascade itself has no media types, properties, panels or easings — every feature is a plugin.
 * Built-in plugins use exactly this API (they're just preinstalled and hidden from plugin lists).
 *
 * UI contribution points are framework-agnostic: they receive a host element and return a
 * cleanup function, so a plugin can use Solid, plain DOM, or anything else — and a future
 * surface (say, a VR workspace) can mount the same panels somewhere else entirely.
 *
 * A plugin runs in two environments:
 *  - "editor": the main window. Everything is available.
 *  - "render": headless export workers. Only stage-side code runs (media type `stage`,
 *    property `apply`/`audio`, easings, param interpolation). UI registrations are no-ops.
 */
import type { Disposable } from './disposable'
import type { Contribution } from './registry'
import type { Clip, EasingRef, Id, MediaItem, MediaMeta, Project, PropertyInstance, Timeline, Track } from '@shared/project'
import type { FFmpegExportPlan } from '@shared/ipc'
import type { Flicks, FrameRate } from '@shared/time'
import type { CascadeAPI } from './app'
import type { TimeMap } from './time-remap'

export type Cleanup = () => void
/** Mount a UI into `el`; return cleanup. */
export type Mount<Ctx> = (el: HTMLElement, ctx: Ctx) => Cleanup | void

/** Icons are a Lucide icon name (e.g. "film") or a raw `<svg …>` string. */
export type Icon = string

export type PluginEnv = 'editor' | 'render'

// ───────────────────────────── plugin definition ─────────────────────────────

export interface PluginDefinition {
  id: string
  name: string
  version?: string
  description?: string
  /** Activation order among plugins; also default priority for its contributions. */
  priority?: number
  /** Other plugin ids that must activate first. */
  dependsOn?: string[]
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void
}

export const definePlugin = (def: PluginDefinition): PluginDefinition => def

export interface PluginContext {
  readonly plugin: { id: string; name: string; builtin: boolean }
  readonly env: PluginEnv
  readonly app: CascadeAPI
  readonly mediaTypes: Registrar<MediaTypeContribution>
  readonly properties: Registrar<PropertyContribution>
  readonly paramTypes: Registrar<ParamTypeContribution>
  readonly easings: Registrar<EasingContribution>
  readonly panels: Registrar<PanelContribution>
  readonly overlays: Registrar<OverlayContribution>
  readonly commands: Registrar<CommandContribution>
  readonly keybindings: Registrar<KeybindingContribution>
  readonly menus: Registrar<MenuItemContribution>
  readonly statusItems: Registrar<StatusItemContribution>
  readonly settings: Registrar<SettingContribution>
  readonly exporters: Registrar<ExporterContribution>
  readonly generators: Registrar<GeneratorContribution>
  /** Register any disposable to be cleaned up when the plugin unloads (hot reload!). */
  track<T extends Disposable>(d: T): T
  log(...args: unknown[]): void
}

export interface Registrar<T> {
  register(value: T): Disposable
}

// ───────────────────────────── units ─────────────────────────────

/**
 * The stage never uses px. Spatial values are stored relative to the frame:
 *  - x: fraction of frame width, y / len: fraction of frame height.
 * `u` converts stored values into CSS lengths that scale with any output resolution.
 */
export interface StageUnits {
  /** fraction of frame width → CSS length */
  x(v: number): string
  /** fraction of frame height → CSS length */
  y(v: number): string
  /** generic length (fraction of frame height) → CSS length */
  len(v: number): string
  /** Actual pixel size of the frame right now (only for canvas / SVG numeric needs). */
  readonly frame: { width: number; height: number }
}

/**
 * How a param is shown and stored.
 *  frameX / frameY / frameLen: stored as frame fractions, displayed in px at the project's reference resolution.
 *  frameXY: vec2 of [frameX, frameY].
 *  percent: stored 1 = 100%.
 */
export type ParamUnit = '' | 'frameX' | 'frameY' | 'frameLen' | 'frameXY' | 'percent' | 'deg' | 's' | 'dB' | 'Hz' | 'x'

// ───────────────────────────── params & properties ─────────────────────────────

export interface ParamDef {
  id: string
  label: string
  /** Param type id: "number", "vec2", "color", "angle", "select", "toggle", "text", "font", … */
  type: string
  default: unknown
  unit?: ParamUnit
  min?: number
  max?: number
  /** Soft range for sliders/scrubbing (min/max still clamp). */
  softMin?: number
  softMax?: number
  step?: number
  options?: { value: string; label: string; icon?: Icon }[]
  /** Defaults to true for interpolatable types. */
  animatable?: boolean
  /** Extra type-specific config (e.g. multiline for text). */
  config?: Record<string, unknown>
  hidden?: boolean
}

/** CSS fragments a property contributes to a clip for the current frame. */
export interface PropertyOutput {
  /** Transform functions, applied after the clip's centering transform, in property-list order. */
  transform?: string[]
  /** Filter functions (`blur(…)`, `url(#svgfilter)`). */
  filter?: string[]
  backdropFilter?: string[]
  /** Inline styles for the clip wrapper (the transformed box). */
  style?: Record<string, string>
  /** Inline styles for the media element inside the wrapper. */
  contentStyle?: Record<string, string>
  /** SVG filter primitives; Cascade wraps them in a <filter> and appends `url(#id)` to `filter`. */
  svgFilter?: string
  /** Free-form data for the media type (e.g. text props) — merged into ClipFrameState.extra. */
  extra?: Record<string, unknown>
}

export interface PropertyApplyContext {
  u: StageUnits
  clip: Clip
  media?: MediaItem
  /** Time relative to clip start. */
  local: Flicks
  mode: 'preview' | 'render'
  playing: boolean
  project: Project
  /**
   * Escape hatch for advanced properties. Prefer returning PropertyOutput. Tag any element you add
   * to the wrapper with `data-cs-owner="<property id>"` so the stage removes it when the property goes away.
   */
  elements: { wrapper: HTMLElement; content: HTMLElement | null; document: Document }
}

export interface AudioPropertyNode {
  input: AudioNode
  output: AudioNode
  /** Called per frame (preview) or per automation step (render) with evaluated values. */
  update(values: Record<string, unknown>, at: number): void
  dispose?(): void
}

export interface PropertyContribution extends Contribution {
  name: string
  description: string
  icon: Icon
  category: string
  keywords?: string[]
  params: ParamDef[]
  /** Media type ids, or a predicate. Undefined = applies to all visual clips. */
  appliesTo?: string[] | ((clip: Clip, media?: MediaItem) => boolean)
  /** Whether more than one instance can be added to a clip. */
  stackable?: boolean
  /** Hint for the preview to degrade during playback. */
  cost?: 'cheap' | 'medium' | 'expensive'
  /** Visual output for this frame. */
  apply?(values: Record<string, unknown>, ctx: PropertyApplyContext): PropertyOutput | void
  /** Audio processing (Web Audio). */
  audio?: { create(ctx: BaseAudioContext, values: Record<string, unknown>): AudioPropertyNode }
  /**
   * Id of a number param that multiplies the clip's playback speed over time (keyframeable).
   * The stage integrates it to map timeline time to source time; linked clips share it.
   */
  timeRemap?: string
  /** Custom inspector UI replacing the default param rows. */
  editor?: Mount<PropertyEditorContext>
  /** Compact one-line summary in the inspector header (e.g. "12px"). */
  summary?(values: Record<string, unknown>): string
}

export interface PropertyEditorContext {
  app: CascadeAPI
  clipId: Id
  propertyId: Id
  /** Read evaluated values at the playhead. */
  values(): Record<string, unknown>
  set(paramId: string, value: unknown, opts?: { gesture?: 'start' | 'update' | 'end' }): void
  subscribe(fn: () => void): Cleanup
}

export interface ParamEditorContext<T = unknown> {
  app: CascadeAPI
  def: ParamDef
  /** Evaluated value at the playhead. */
  get(): T
  /** Set value (creates/updates a keyframe at the playhead if the param is animated). */
  set(value: T, opts?: { gesture?: 'start' | 'update' | 'end' }): void
  subscribe(fn: () => void): Cleanup
  /** Display helpers for units (px at reference resolution, %, …). */
  toDisplay(v: number, axis?: 0 | 1): number
  fromDisplay(v: number, axis?: 0 | 1): number
  unitLabel(axis?: 0 | 1): string
  readonly animated: boolean
  /** True when a keyframe sits exactly at the playhead. */
  keyed(): boolean
}

export interface ParamTypeContribution<T = any> extends Contribution {
  /** Linear interpolation; absent → values hold until the next keyframe. */
  interpolate?(a: T, b: T, p: number): T
  /** Normalize/validate a stored value. */
  coerce?(v: unknown, def: ParamDef): T
  /** Inline editor in the inspector row. */
  editor: Mount<ParamEditorContext<T>>
  /** Value → short string for the keyframe panel/tooltips. */
  format?(v: T, def: ParamDef): string
  /** Numeric channels for the graph editor (e.g. vec2 → 2). */
  channels?(v: T): number[]
}

export interface EasingContribution extends Contribution {
  name: string
  /** Shape of the keyframe diamond in UIs. */
  glyph?: 'diamond' | 'circle' | 'square' | 'hourglass' | 'triangle'
  params?: { label: string; default: number; min?: number; max?: number; step?: number }[]
  /** p in [0,1] → eased progress (may overshoot). */
  fn(p: number, params: number[]): number
  /** Shown in the preset grid; lower first. */
  group?: string
}

// ───────────────────────────── media types ─────────────────────────────

export interface ClipFrameState {
  /** Timeline time. */
  time: Flicks
  /** Time since clip start. */
  local: Flicks
  /** Seconds into the source media (accounts for sourceIn and speed). */
  sourceTime: number
  playing: boolean
  /** Playback rate × the clip's speed at this instant. */
  rate: number
  /** Clip-local → source mapping (speed may vary over time). */
  remap: TimeMap
  clip: Clip
  media?: MediaItem
  project: Project
  mode: 'preview' | 'render'
  /** Extra values contributed by properties (PropertyOutput.extra). */
  extra: Record<string, unknown>
  u: StageUnits
}

export interface ClipInstance {
  /** Visual content element (absent for audio-only types). */
  el?: HTMLElement
  update(state: ClipFrameState): void
  /** Render mode: resolve once content for `state` is exactly on screen (e.g. the decoded frame). */
  prepare?(state: ClipFrameState): Promise<void>
  /**
   * Audio source node (audio-capable types). The stage connects it through the clip's audio
   * properties (gain, pan, EQ…) to the mix. Created from `ClipMountContext.audio.context`.
   */
  audioOut?: AudioNode
  dispose(): void
}

export interface ClipMountContext {
  clip: Clip
  media?: MediaItem
  project: Project
  document: Document
  mode: 'preview' | 'render'
  u: StageUnits
  /** URL for streaming a local media file (supports range requests). */
  mediaUrl(path: string): string
  audio?: StageAudio
}

export interface StageAudio {
  context: BaseAudioContext
  /** Connect your source chain's end to this. */
  destination: AudioNode
  /** Render mode: decoded PCM for a media range (seconds). */
  getBuffer?(media: MediaItem, startSec: number, durationSec: number): Promise<AudioBuffer | null>
  /**
   * Render mode: audio already processed for a clip (e.g. time-stretched by ffmpeg), starting at
   * clip-local `localSec`. Null when the clip has none; use `getBuffer` on the source then.
   */
  getClipBuffer?(clip: Clip, localSec: number, durationSec: number): Promise<AudioBuffer | null>
  /** Render mode: the chunk being rendered, in timeline seconds. */
  chunk?: { start: number; duration: number }
}

export interface ImportCandidate {
  path: string
  name: string
  ext: string
  meta?: MediaMeta
  mime?: string
}

export interface MediaTypeContribution extends Contribution {
  name: string
  icon: Icon
  /** Clip color in the timeline (CSS color). */
  color: string
  /** Which track kind its clips live on. */
  track: 'visual' | 'audio'
  /** File extensions handled (lowercase, no dot). */
  extensions?: string[]
  /** Finer import matching; return a confidence 0..1. */
  accepts?(file: ImportCandidate): number
  /** Whether clips have an intrinsic duration from the media. */
  timeBased?: boolean
  /** Default clip length for non-time-based media (seconds). */
  defaultDuration?: number
  /** Property type ids added to new clips (always shown, in this order). */
  defaultProperties?: string[]
  /** Initial clip.data. */
  defaultData?(media?: MediaItem): Record<string, unknown>
  /** Optional: create a linked audio clip of this media type for media with audio. */
  linkedAudioType?: string
  stage: { mount(ctx: ClipMountContext): ClipInstance }
  /** Timeline clip body renderer (thumbnails, waveform…). Editor only. */
  clipBody?: Mount<ClipBodyContext>
  /** Sources panel thumbnail. Editor only. */
  thumbnail?: Mount<{ media: MediaItem; app: CascadeAPI }>
}

export interface ClipBodyContext {
  app: CascadeAPI
  clip: () => Clip
  media: () => MediaItem | undefined
  /** Visible portion of the clip in clip-local flicks and the pixel scale. */
  view: () => { pxPerSecond: number; visibleStart: Flicks; visibleEnd: Flicks; height: number }
  subscribe(fn: () => void): Cleanup
}

/** Sources that aren't files (text, solid color, shapes…). */
export interface GeneratorContribution extends Contribution {
  name: string
  description: string
  icon: Icon
  mediaType: string
  /** `project` is the current document, e.g. to size things for the frame's aspect ratio. */
  create(project: Project): {
    name: string
    data?: Record<string, unknown>
    clipData?: Record<string, unknown>
    /** Properties (with initial values) added to clips made from this source, after the media type defaults. */
    properties?: { type: string; values?: Record<string, unknown> }[]
  }
}

// ───────────────────────────── workbench ─────────────────────────────

export type PanelRegion = 'side' | 'top' | 'bottom'

export interface PanelContext {
  app: CascadeAPI
  panelId: string
  /** Signals when the panel becomes visible/hidden (bottom tabs). */
  onVisibility(fn: (visible: boolean) => void): Cleanup
}

export interface PanelContribution extends Contribution {
  title: string
  icon: Icon
  region: PanelRegion
  /** Order within region / tab bar. */
  order?: number
  mount: Mount<PanelContext>
  /** Optional header actions rendered by the workbench. */
  actions?: Mount<PanelContext>
}

/**
 * Editor-only layers drawn over the preview (gizmos, guides, motion paths, safe areas…).
 * They get coordinate transforms between frame space (0..1) and screen px.
 */
export interface OverlayContext {
  app: CascadeAPI
  /** Frame rect in overlay-local px. */
  frameRect(): { x: number; y: number; width: number; height: number }
  frameToScreen(fx: number, fy: number): { x: number; y: number }
  screenToFrame(x: number, y: number): { x: number; y: number }
  /** Live DOM element for a clip in the stage document (for measuring). */
  clipElement(clipId: Id): HTMLElement | null
  /** Called every rendered frame and on resize. */
  onFrame(fn: () => void): Cleanup
}

export interface OverlayContribution extends Contribution {
  name: string
  /** Default on? Users can toggle overlays from the preview header. */
  defaultEnabled?: boolean
  mount: Mount<OverlayContext>
}

export interface CommandContribution extends Contribution {
  title: string
  icon?: Icon
  category?: string
  run(app: CascadeAPI, ...args: any[]): unknown
  enabled?(app: CascadeAPI): boolean
}

export interface KeybindingContribution extends Contribution {
  /** e.g. "Space", "Mod+Z", "Shift+Delete", "B" */
  key: string
  command: string
  args?: unknown[]
  /** Only fire when focus is within this panel (or anywhere if absent). */
  when?: string
}

/** `app/*` locations make up the native application menu (File, Edit, Timeline, Playback, View, Help). */
export type MenuLocation =
  | 'clip/context' | 'timeline/context' | 'track/context' | 'source/context' | 'keyframe/context'
  | 'app/file' | 'app/edit' | 'app/timeline' | 'app/playback' | 'app/view' | 'app/help'
  /** @deprecated use 'app/file' */
  | 'app/main'

export interface MenuItemContribution extends Contribution {
  location: MenuLocation
  label: string
  icon?: Icon
  command: string
  group?: string
  order?: number
  shortcut?: string
  /** Arguments passed to the command. */
  args?: unknown[]
  when?(app: CascadeAPI, target: unknown): boolean
  /** Shown as a checkbox (native menu). */
  checked?(app: CascadeAPI): boolean
}

export interface StatusItemContribution extends Contribution {
  align?: 'left' | 'right'
  order?: number
  mount: Mount<{ app: CascadeAPI }>
}

export interface SettingContribution extends Contribution {
  label: string
  description?: string
  section: string
  type: 'toggle' | 'number' | 'select' | 'text'
  default: unknown
  options?: { value: string; label: string }[]
}

export interface ExportJobSpec {
  width: number
  height: number
  fps: FrameRate
  range: { start: Flicks; end: Flicks }
  output: string
  exporter: string
  options: Record<string, unknown>
}

/** An output format. The main process does the heavy lifting; this describes the options. */
export interface ExporterContribution extends Contribution {
  name: string
  extension: string
  description: string
  icon?: Icon
  /** Option schema shown in the Export panel. */
  options: ParamDef[]
  video: boolean
  audio: boolean
  /** Renderer computes the serializable encoding plan sent as ExportRequest.encoding. */
  ffmpeg(options: Record<string, unknown>, info: {
    width: number; height: number; fps: FrameRate; hasAudio: boolean; hwEncoders: string[]
  }): FFmpegExportPlan
}

// ───────────────────────────── helpers re-exported for plugin authors ─────────────────────────────

export type { Clip, EasingRef, Id, MediaItem, MediaMeta, Project, PropertyInstance, Timeline, Track, Flicks, FrameRate }
