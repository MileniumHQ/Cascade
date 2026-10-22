import type { CascadeAPI } from '@core/app'
import { PlaybackService } from '@core/app'
import { Emitter } from '@core/events'
import type { MediaTypeContribution } from '@core/plugin-api'
import { Value } from '@core/value'
import { uid, type Clip, type Id, type MediaItem, type Project, type Timeline, type Track } from '@shared/project'
import { snapToFrame, type Flicks } from '@shared/time'
import type { EngineFeed } from '../preview/engine'
import { isEmpty, marksOf, markIn, markOut, writeMarks, type SourceMarks } from './marks'

const TIMELINE_ID = 'tl_source'

export interface Lanes {
  visual: boolean
  audio: boolean
}

/** One source item as the stage sees it: a throwaway project holding just its clip(s). */
interface Built {
  media: MediaItem
  mt: MediaTypeContribution
  project: Project
  /** The clip that stands for the item (its visual clip, else its audio clip). */
  clip: Clip
  duration: Flicks
  /** Whether the item has a track of each kind (decides which lane toggles make sense). */
  lanes: Lanes
}

/**
 * The source monitor's state: the opened item, its own transport and its marks. Marks live in
 * `project.pluginData` (per media id) so they save with the project; the item is shown by rendering
 * a one-clip project through the same stage as the timeline, so every media type works unchanged.
 */
export class SourceMonitor {
  readonly mediaId = new Value<Id | null>(null)
  readonly playback: PlaybackService
  /** Which lanes an edit from the monitor brings (video / audio only toggles). */
  readonly lanes = new Value<Lanes>({ visual: true, audio: true }, (a, b) => a.visual === b.visual && a.audio === b.audio)
  /** Marks of the open item. */
  readonly marks = new Value<SourceMarks>({}, (a, b) => a.in === b.in && a.out === b.out)
  /** Fires when the throwaway project is rebuilt (item opened, relinked, media type changed). */
  readonly rebuilt = new Emitter<void>()
  private built: Built | null = null
  private empty: Project

  constructor(private app: CascadeAPI) {
    this.playback = new PlaybackService({ duration: () => this.duration(), fps: () => app.fps() })
    this.empty = this.makeProject([])
    const doc = app.doc.onChange.on((e) => {
      const id = this.mediaId.get()
      if (!id) return
      if (e.source === 'load') return this.close()
      const media = app.project().media[id]
      if (!media) return this.close()
      if (media !== this.built?.media || app.project().settings !== this.built.project.settings) this.rebuild()
      this.marks.set(marksOf(app.project(), id))
    })
    const types = app.registries.mediaTypes.onChange.on(() => this.mediaId.get() && this.rebuild())
    // Only one transport plays at a time.
    const tl = app.playback.playing.subscribe((p) => p && this.playback.pause())
    const own = this.playback.playing.subscribe((p) => p && app.playback.pause())
    this.dispose = () => [doc, types, tl, own].forEach((d) => d.dispose())
  }

  dispose: () => void

  duration(): Flicks {
    return this.built?.duration ?? 0
  }
  item(): Built | null {
    return this.built
  }

  open(mediaId: Id) {
    if (!this.app.project().media[mediaId]) return
    this.playback.pause()
    this.mediaId.set(mediaId)
    this.rebuild()
    this.playback.seek(markedStart(this.marks.get()))
  }

  close() {
    this.playback.pause()
    this.mediaId.set(null)
    this.built = null
    this.marks.set({})
    this.rebuild()
  }

  private rebuild() {
    const id = this.mediaId.get()
    const media = id ? this.app.project().media[id] : undefined
    this.built = media ? this.build(media) : null
    if (id) this.marks.set(marksOf(this.app.project(), id))
    this.playback.seek(Math.min(this.playback.time.get(), this.duration()))
    this.rebuilt.emit()
  }

  private build(media: MediaItem): Built | null {
    const app = this.app
    const mt = app.registries.mediaTypes.get(media.type)
    if (!mt) return null
    const primary = app.edit.buildClip(media, 0)
    if (!primary) return null
    const clips: { clip: Clip; kind: Track['kind'] }[] = [{ clip: primary, kind: mt.track }]
    if (mt.linkedAudioType && media.meta.hasAudio) {
      const audio = app.edit.buildClip(media, 0, mt.linkedAudioType)
      if (audio) {
        const link = uid('ln_')
        primary.linkId = link
        audio.linkId = link
        audio.duration = primary.duration
        clips.push({ clip: audio, kind: 'audio' })
      }
    }
    const project = this.makeProject(clips, media)
    const kinds = new Set(clips.map((c) => c.kind))
    return { media, mt, project, clip: primary, duration: primary.duration, lanes: { visual: kinds.has('visual'), audio: kinds.has('audio') } }
  }

  /** The editor's project settings with a single timeline holding `clips`, one per kind. */
  private makeProject(clips: { clip: Clip; kind: Track['kind'] }[], media?: MediaItem): Project {
    const base = this.app.project()
    const tracks: Track[] = (['visual', 'audio'] as const).map((kind) => ({
      id: `tr_source_${kind}`,
      kind,
      name: kind === 'visual' ? 'V1' : 'A1',
      hidden: false,
      muted: false,
      locked: false,
      clips: clips.filter((c) => c.kind === kind).map((c) => c.clip)
    }))
    const tl: Timeline = { id: TIMELINE_ID, name: 'Source', tracks, markers: [] }
    return {
      ...base,
      media: media ? { [media.id]: media } : {},
      mediaOrder: media ? [media.id] : [],
      timelines: { [TIMELINE_ID]: tl },
      timelineOrder: [TIMELINE_ID],
      activeTimeline: TIMELINE_ID,
      pluginData: {}
    }
  }

  /** What the preview engine needs to render this monitor instead of the timeline. */
  feed(): EngineFeed {
    return {
      project: () => this.built?.project ?? this.sizedEmpty(),
      timelineId: () => TIMELINE_ID,
      time: this.playback.time,
      playing: this.playback.playing,
      rate: this.playback.rate,
      onChange: (fn) => this.rebuilt.on(fn),
      primary: false
    }
  }

  /** The empty project follows the editor's frame size and background. */
  private sizedEmpty() {
    const s = this.app.project().settings
    if (this.empty.settings !== s) this.empty = this.makeProject([])
    return this.empty
  }

  // ───────────── marks ─────────────

  /** Current time snapped to the project's frames, as an offset into the item. */
  private here(): Flicks {
    return snapToFrame(this.playback.time.get(), this.app.fps())
  }

  private setMarks(m: SourceMarks) {
    const id = this.mediaId.get()
    if (!id) return
    this.marks.set(m)
    // Marks aren't edits: stored in the project (so they save) without an undo step.
    this.app.doc.transact('Source marks', (d) => writeMarks(d.pluginData, id, m), { silent: true })
  }

  markIn(t: Flicks = this.here()) {
    this.setMarks(markIn(this.marks.get(), t, this.duration()))
  }
  markOut(t: Flicks = this.here()) {
    this.setMarks(markOut(this.marks.get(), t, this.duration()))
  }
  clearMarks() {
    if (!isEmpty(this.marks.get())) this.setMarks({})
  }
  goToIn() {
    this.playback.pause()
    this.playback.seek(this.marks.get().in ?? 0)
  }
  goToOut() {
    this.playback.pause()
    this.playback.seek(this.marks.get().out ?? this.duration())
  }
}

const markedStart = (m: SourceMarks) => m.in ?? 0
