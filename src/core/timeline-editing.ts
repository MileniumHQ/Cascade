import type { CascadeAPI } from './app'
import { createTimeline, findClip, timelineDuration, uid, type Id, type MediaItem } from '@shared/project'
import { Value } from './value'
import { canReferenceTimeline, timelineDependencies } from './compositions'
import { breakApart, cloneTimeline, nestClips, nestReason } from './nesting'
import { clipTimeMap } from './time-remap'
import { placeClip } from './timeline-ops'
import { transitionWindow } from './transitions'

export interface CreateTimelineOptions { name?: string }
export interface NestClipsOptions { mediaType: string; name?: string }

/** Undoable structure, transient navigation. All timelines inherit project size/fps. */
export class TimelineEditing {
  readonly history = new Value<Id[]>([])
  private positions = new Map<Id, number>()
  private projectId: Id
  private active: Id
  constructor(private app: CascadeAPI) {
    this.projectId = app.project().id
    this.active = app.project().activeTimeline
    app.doc.onChange.on(e => {
      const p = app.project()
      if (e.source === 'load' || this.projectId !== p.id) {
        this.positions.clear()
        this.history.set([])
        this.projectId = p.id
      }
      if (!p.timelines[p.activeTimeline]) {
        const fallback = p.timelineOrder.find(id => !!p.timelines[id])
        if (fallback) app.doc.transact('Switch timeline', d => { d.activeTimeline = fallback }, { silent: true })
        return
      }
      if (this.active !== p.activeTimeline || e.source === 'load') {
        if (e.source !== 'load') this.positions.set(this.active, app.playback.time.get())
        this.active = p.activeTimeline
        app.playback.pause()
        app.selection.setClips([])
        app.selection.keyframes.set([])
        app.selection.media.set([])
        app.selection.property.set(null)
        app.selection.track.set(null)
        app.selection.targets.set({})
        app.playback.seek(e.source === 'load' ? 0 : this.positions.get(this.active) ?? 0)
        app.view.scrollX.set(0)
      }
    })
  }
  create(opts: CreateTimelineOptions = {}): Id {
    const tl = createTimeline(opts.name?.trim() || `Timeline ${this.app.project().timelineOrder.length + 1}`)
    this.app.doc.transact('Create timeline', d => { d.timelines[tl.id] = tl; d.timelineOrder.push(tl.id) })
    return tl.id
  }
  duplicate(id: Id): Id | null {
    const source = this.app.project().timelines[id]
    if (!source) return null
    const tl = cloneTimeline(source)
    this.app.doc.transact('Duplicate timeline', d => {
      d.timelines[tl.id] = tl
      d.timelineOrder.splice(d.timelineOrder.indexOf(id) + 1, 0, tl.id)
    })
    return tl.id
  }
  rename(id: Id, name: string): void {
    if (!name.trim()) return
    this.app.doc.transact('Rename timeline', d => { if (d.timelines[id]) d.timelines[id].name = name.trim() })
  }
  deleteReason(id: Id): string | null {
    const p = this.app.project()
    if (!p.timelines[id]) return 'Timeline not found'
    if (Object.keys(p.timelines).length <= 1) return 'Keep at least one timeline'
    if (Object.keys(p.timelines).some(owner => timelineDependencies(p, owner).has(id))) return 'This timeline is used by a composition clip'
    return null
  }
  delete(id: Id): boolean {
    const reason = this.deleteReason(id)
    if (reason) { this.app.notify('warning', reason); return false }
    this.app.doc.transact('Delete timeline', d => {
      delete d.timelines[id]
      d.timelineOrder = d.timelineOrder.filter(x => x !== id)
      if (d.activeTimeline === id) d.activeTimeline = d.timelineOrder[0]
      // An unused source can go with the timeline; used references were checked above.
      const media = new Set(Object.values(d.media).filter(m => m.timelineId === id).map(m => m.id))
      for (const mid of media) delete d.media[mid]
      d.mediaOrder = d.mediaOrder.filter(mid => !media.has(mid))
    })
    return true
  }
  reorder(id: Id, index: number): void {
    if (!Number.isFinite(index)) return
    this.app.doc.transact('Reorder timelines', d => {
      if (!d.timelineOrder.includes(id)) return
      d.timelineOrder = d.timelineOrder.filter(x => x !== id)
      d.timelineOrder.splice(Math.max(0, Math.min(d.timelineOrder.length, Math.round(index))), 0, id)
    })
  }
  setActive(id: Id, remember = false): void {
    const p = this.app.project()
    if (!p.timelines[id] || id === p.activeTimeline) return
    if (remember) this.history.set([...this.history.get(), p.activeTimeline])
    this.app.doc.transact('Switch timeline', d => { d.activeTimeline = id }, { silent: true })
  }
  back(): void {
    const history = [...this.history.get()]
    let id: Id | undefined
    while (history.length && !id) { const next = history.pop()!; if (this.app.project().timelines[next]) id = next }
    this.history.set(history)
    if (id) this.setActive(id)
  }
  addComposition(timelineId: Id, mediaType: string, opts: { start?: number; trackId?: Id } = {}): Id | null {
    const p = this.app.project(), source = p.timelines[timelineId]
    const mt = this.app.registries.mediaTypes.get(mediaType)
    if (!source || !mt || mt.track !== 'visual') return null
    if (!canReferenceTimeline(p, p.activeTimeline, timelineId)) {
      this.app.notify('warning', 'A composition cannot contain itself, directly or indirectly')
      return null
    }
    if (!timelineDuration(source)) { this.app.notify('warning', 'Add clips to this timeline first'); return null }
    const existing = Object.values(p.media).find(m => m.type === mediaType && m.timelineId === timelineId)
    const media: MediaItem = existing ?? { id: uid('md_'), name: source.name, type: mediaType, timelineId, meta: { duration: timelineDuration(source) } }
    const clip = this.app.edit.buildClip(media, opts.start ?? this.app.playback.time.get())
    if (!clip) return null
    const target = this.app.timeline().tracks.find(t => t.id === opts.trackId && t.kind === 'visual' && !t.locked)
      ?? this.app.timeline().tracks.find(t => t.kind === 'visual' && !t.locked)
    if (!target) { this.app.notify('warning', 'Unlock a video track first'); return null }
    this.app.doc.transact('Add composition', d => {
      if (!existing) { d.media[media.id] = media; d.mediaOrder.push(media.id) }
      placeClip(d.timelines[d.activeTimeline].tracks.find(t => t.id === target.id)!, clip)
    })
    this.app.selection.setClips([clip.id])
    return clip.id
  }
  nestReason(ids: Iterable<Id>): string | null { return nestReason(this.app.timeline(), ids) }
  nest(ids: Id[], opts: NestClipsOptions): Id | null {
    const reason = this.nestReason(ids)
    if (reason) { this.app.notify('warning', reason); return null }
    const mt = this.app.registries.mediaTypes.get(opts.mediaType)
    if (!mt || mt.track !== 'visual') return null
    const id = uid('tl_'), name = opts.name?.trim() || 'Nested timeline'
    const media: MediaItem = { id: uid('md_'), type: mt.id, name, timelineId: id, meta: {} }
    const clip = this.app.edit.buildClip(media, 0)
    if (!clip) return null
    this.app.doc.transact('Nest clips', d => {
      const tl = nestClips(d.timelines[d.activeTimeline], ids, clip, id, name)
      if (!tl) return
      d.timelines[id] = tl
      d.timelineOrder.push(id)
      media.meta.duration = timelineDuration(tl)
      d.media[media.id] = media
      d.mediaOrder.push(media.id)
    })
    this.app.selection.setClips([clip.id])
    return clip.id
  }
  breakApartReason(id: Id): string | null {
    const p = this.app.project(), tl = this.app.timeline(), found = findClip(tl, id)
    const clip = found?.clip, ref = clip?.mediaId && p.media[clip.mediaId]?.timelineId
    if (!clip || !ref || !p.timelines[ref]) return 'Select a composition clip'
    if (found!.track.locked) return 'Unlock the clip track first'
    if (found!.track.hidden || found!.track.muted || found!.track.gain || found!.track.pan) return 'Reset the composition track’s visibility and mix settings before breaking it apart'
    const map = clipTimeMap(clip, tl, this.app.registries)
    if (map.constant !== 1 || map.reversed) return 'Break apart requires constant forward 1× speed'
    if (clip.properties.some(prop => prop.enabled && !this.app.registries.properties.get(prop.type)?.timeRemap))
      return 'Remove the composition clip’s effects before breaking it apart'
    if (found!.track.transitions?.some(tx => tx.from === id || tx.to === id)) return 'Remove the composition clip’s transitions before breaking it apart'
    const nested = p.timelines[ref], from = clip.sourceIn, to = from + clip.duration
    if (from < 0 || to > timelineDuration(nested)) return 'Trim the composition clip to the current source duration before breaking it apart'
    for (const tr of nested.tracks) for (const tx of tr.transitions ?? []) {
      const window = transitionWindow(tr, tx)
      if (window && (window.start < from && window.end > from || window.start < to && window.end > to))
        return 'Trim outside nested transitions before breaking it apart'
    }
    if (!canReferenceTimeline(p, p.activeTimeline, ref)) return 'Composition contains a recursive reference'
    return null
  }
  breakApart(id: Id): Id[] | null {
    const reason = this.breakApartReason(id)
    if (reason) { this.app.notify('warning', reason); return null }
    const p = this.app.project(), found = findClip(this.app.timeline(), id)!, ref = p.media[found.clip.mediaId!].timelineId!
    const source = p.timelines[ref]
    let result: Id[] | null = null
    this.app.doc.transact('Break apart', d => {
      result = breakApart(d.timelines[d.activeTimeline], id, source, c => clipTimeMap(c, source, this.app.registries))
    })
    if (result) this.app.selection.setClips(result)
    return result
  }
}
