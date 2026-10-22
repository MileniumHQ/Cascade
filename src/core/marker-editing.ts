import type { CascadeAPI } from './app'
import type { GestureOpts } from './editing'
import { findClip, uid, type Id, type Marker } from '@shared/project'
import type { Flicks } from '@shared/time'
import { clipMarkerSourceTime, findMarker } from './markers'
export interface AddMarkerOptions { clipId?: Id; duration?: Flicks; color?: string; kind?: string; note?: string; data?: unknown }
export class MarkerEditing {
  constructor(private app: CascadeAPI) {}
  add(t: Flicks, name = '', opts: AddMarkerOptions = {}): Id {
    const { clipId, ...fields } = opts
    const f = clipId ? findClip(this.app.timeline(), clipId) : null
    if (!Number.isFinite(t) || clipId && (!f || f.track.locked)) return ''
    const marker: Marker = { ...structuredClone(fields), id: uid('mk_'), name, t: Math.max(0, Math.round(f ? clipMarkerSourceTime(f.clip, this.app.edit.timeMap(f.clip), t) : t)) }
    if (marker.duration !== undefined) marker.duration = Math.max(0, Math.round(marker.duration || 0))
    this.app.doc.transact('Add marker', d => {
      const tl = d.timelines[d.activeTimeline]
      const markers = clipId ? (findClip(tl, clipId)!.clip.markers ??= []) : tl.markers
      markers.push(marker)
    })
    return marker.id
  }
  update(id: Id, patch: Partial<Omit<Marker, 'id'>>, opts?: GestureOpts): void {
    const found = findMarker(this.app.timeline(), id)
    if (!found || found.locked) return
    const key = `marker:${id}`
    if (opts?.gesture === 'start') this.app.doc.beginGesture(key)
    this.app.doc.transact('Edit marker', d => {
      const marker = findMarker(d.timelines[d.activeTimeline], id)!.marker
      Object.assign(marker, structuredClone(patch), { id })
      if (!Number.isFinite(marker.t)) marker.t = found.marker.t
      marker.t = Math.max(0, Math.round(marker.t))
      if (marker.duration !== undefined) marker.duration = Math.max(0, Math.round(marker.duration || 0))
    }, opts ? { coalesce: key } : {})
    if (opts?.gesture === 'end') this.app.doc.endGesture()
  }
  move(id: Id, t: Flicks, opts?: GestureOpts): void {
    const f = findMarker(this.app.timeline(), id)
    if (!f || !Number.isFinite(t)) return
    this.update(id, { t: f.clip ? clipMarkerSourceTime(f.clip, this.app.edit.timeMap(f.clip), t) : t }, opts)
  }
  remove(ids: Id[]): void {
    const selected = new Set(ids)
    this.app.doc.transact('Delete markers', d => {
      const tl = d.timelines[d.activeTimeline]
      tl.markers = tl.markers.filter(m => !selected.has(m.id))
      for (const tr of tl.tracks) if (!tr.locked) for (const c of tr.clips) if (c.markers) c.markers = c.markers.filter(m => !selected.has(m.id))
    })
  }
}
