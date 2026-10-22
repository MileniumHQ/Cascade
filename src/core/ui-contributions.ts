import type { Clip, Id, MediaItem, Project, Track } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { Disposable } from './disposable'
import type { CascadeAPI } from './app'
import type { Value } from './value'
import type { Contribution } from './registry'

/**
 * Framework-agnostic UI extension points for the built-in panels. Every one follows the
 * `mount(el, ctx) => cleanup` convention, so a plugin can use any UI library (or none).
 * Documented in docs/ui-contributions.md; examples/plugins/ui-contributions.ts.
 */
export type UiCleanup = () => void

// ───────────────────────────── timeline decorations ─────────────────────────────

/** Where on the timeline a decoration is mounted. */
export type TimelineDecorationTarget = 'ruler' | 'track' | 'clip'

/**
 * Time ↔ pixel mapping and geometry of the area a decoration covers. `x(t)` is relative to the
 * left edge of that area: the lane start for `ruler` and `track`, the clip's own left edge for `clip`.
 * All functions read live values; call `subscribe` to learn when to redraw (zoom, scroll, resize, edits).
 */
export interface TimelineDecorationContext {
  app: CascadeAPI
  target: TimelineDecorationTarget
  /** Pixel offset of a timeline time inside the decorated area (may be negative or beyond `width()`). */
  x(time: Flicks): number
  /** Inverse of `x`. */
  timeAt(x: number): Flicks
  /** Width / height in px of the decorated area (lane viewport, or the clip's visible rectangle / track row). */
  width(): number
  height(): number
  /** Timeline times at the area's left and right edges. */
  range(): { start: Flicks; end: Flicks }
  /** Only for `track` and `clip` targets. Track is always the owning track of the clip. */
  track(): Track | null
  clip(): Clip | null
  /**
   * Snap a time like the timeline does (frames, clip edges, playhead and every registered `snapTargets`
   * provider). `exclude` lists ids (clips, markers…) that must not snap to themselves; `disable` forces frame snapping only.
   */
  snap(time: Flicks, exclude?: Set<Id>, disable?: boolean): Flicks
  /** Show / hide the timeline's snap indicator line at a time while dragging. */
  showSnapGuide(time: Flicks | null): void
  /** Fires on zoom, scroll, resize and document changes. */
  subscribe(fn: () => void): UiCleanup
}

export interface TimelineDecorationContribution extends Contribution {
  target: TimelineDecorationTarget
  /** Stacking among decorations of one target (lower first). */
  order?: number
  /** Decide per track / clip (e.g. only video tracks). Omitted = always. */
  when?(app: CascadeAPI, subject: { track?: Track; clip?: Clip }): boolean
  mount(el: HTMLElement, ctx: TimelineDecorationContext): UiCleanup | void
}

/**
 * Extra snap points. The timeline merges every provider's points with clip edges and the playhead.
 * `exclude` holds the ids being dragged (never snap an item to itself).
 */
export interface SnapTargetContribution extends Contribution {
  points(app: CascadeAPI, exclude: Set<Id>): Flicks[]
}

/** A popup menu entry; structurally the same as the UI kit's `MenuItem`. */
export interface PopupMenuItem {
  label?: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  run?: () => void
  children?: PopupMenuItem[]
}

export interface TimelineMenuHit {
  track: Track
  /** The clip under the pointer (clip menus only). */
  clipId?: Id
  /** Timeline time under the pointer. */
  time: Flicks
}

/**
 * Items a plugin adds at the top of the timeline's context menu: `clip` = right click on a clip,
 * `lane` = right click on empty lane space. Return `[]` to add nothing.
 */
export interface TimelineMenuContribution extends Contribution {
  target: 'clip' | 'lane'
  order?: number
  items(app: CascadeAPI, hit: TimelineMenuHit): PopupMenuItem[]
}

// ───────────────────────────── timeline drops ─────────────────────────────

export interface TimelineDropTarget {
  /** Snapped drop time. */
  start: Flicks
  /** The unlocked track under the pointer, if any. */
  trackId?: Id
  trackKind?: Track['kind']
}

/**
 * Handles drags onto the timeline. The first handler (by priority) whose `accepts` returns true
 * receives the drop; the built-in media / generator / OS-file drops are the fallback.
 * `accepts` runs on dragover, where only `dataTransfer.types` is readable.
 */
export interface TimelineDropContribution extends Contribution {
  accepts(dataTransfer: DataTransfer): boolean
  drop(app: CascadeAPI, dataTransfer: DataTransfer, target: TimelineDropTarget): void | Promise<void>
}

// ───────────────────────────── inspector sections ─────────────────────────────

/**
 * An inspector view for a kind of selection. `subject` is a free-form selection kind; the Clip
 * inspector itself owns `clip` and `media`. For every other subject the inspector shows the first
 * section (by priority) whose `selection(app)` currently holds ids. Subject `clip` sections instead
 * append below the clip's own cards (for the focused clip); they need no `selection`.
 */
export interface InspectorSectionContribution extends Contribution {
  subject: 'clip' | (string & {})
  /** Selected ids for this subject (e.g. `app => app.selection.transitions`). Required unless `subject` is `clip`. */
  selection?(app: CascadeAPI): Value<Id[]>
  /** Hide in some situations (e.g. a missing definition). */
  when?(app: CascadeAPI, ids: Id[]): boolean
  mount(el: HTMLElement, ctx: InspectorSectionContext): UiCleanup | void
}

export interface InspectorSectionContext {
  app: CascadeAPI
  /** Selected ids; the section is remounted when the first id changes, `subscribe` covers the rest. */
  ids(): Id[]
  /** Fires when the selection or the document changes. */
  subscribe(fn: () => void): UiCleanup
}

// ───────────────────────────── sources panel ─────────────────────────────

/** An extra collapsible-style block in the Sources panel (above the media list), e.g. Timelines. */
export interface SourceSectionContribution extends Contribution {
  order?: number
  mount(el: HTMLElement, ctx: { app: CascadeAPI }): UiCleanup | void
}

/**
 * Decorates every media item in the Sources panel (bars, badges). Mounted into the item's
 * thumbnail overlay; re-read with `subscribe` when the project changes.
 */
export interface SourceItemDecorationContribution extends Contribution {
  mount(el: HTMLElement, ctx: SourceItemDecorationContext): UiCleanup | void
}
export interface SourceItemDecorationContext {
  app: CascadeAPI
  mediaId: Id
  media(): MediaItem | undefined
  subscribe(fn: () => void): UiCleanup
}

// ───────────────────────────── viewer service ─────────────────────────────

/** `app.services` key under which the preview plugin publishes {@link ViewerService}. */
export const VIEWER_SERVICE = 'viewer'

/** What a viewer shows and how it is driven: the editor timeline by default, or any other project (the source monitor). */
export interface ViewerFeed {
  project(): Project
  timelineId(): Id
  time: Value<Flicks>
  playing: Value<boolean>
  rate: Value<number>
  /** Fires when the project's content changes. */
  onChange(fn: () => void): Disposable
  /** The editor's own preview: its audio feeds the app's meters and its frame rate the playback stats. */
  primary: boolean
}

/** A live stage rendering a feed into a host element. */
export interface Viewer {
  /** Size the stage is displayed at (css px); the viewer renders at an adaptive internal resolution. */
  setDisplaySize(width: number, height: number): void
  /** Ask for a re-render (e.g. when a hidden viewer becomes visible). */
  request(): void
  dispose(): void
}

/** Public access to the preview engine, so other panels (the source monitor) can show frames. */
export interface ViewerService {
  create(host: HTMLElement, feed?: ViewerFeed): Viewer
}
