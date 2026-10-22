import { type Clip, type Id, type Marker, type Project, type Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'
import { sourceSpan, type TimeMap } from './time-remap'

/** Source coordinates are independent of trims/slips; null means the source frame is hidden. */
export function clipMarkerTimelineTime(clip: Clip, map: TimeMap, marker: Marker): Flicks | null {
  const span = sourceSpan(clip, map)
  if (marker.t < span.lo || marker.t > span.hi) return null
  const local = map.localAt(marker.t - clip.sourceIn)
  return Number.isFinite(local) && local >= 0 && local < clip.duration ? Math.round(clip.start + local) : null
}
export function clipMarkerSourceTime(clip: Clip, map: TimeMap, timelineT: Flicks): Flicks {
  return Math.round(clip.sourceIn + map.offset(timelineT - clip.start))
}

/** Returns new objects; deletion uses a half-open interval and never leaves negative times. */
export function shiftMarkers(markers: Marker[], at: Flicks, delta: Flicks): Marker[] {
  return markers.filter(m => !(delta < 0 && m.t >= at && m.t < at - delta))
    .map(m => m.t >= at ? { ...m, t: Math.max(0, m.t + delta) } : m)
}
export function findMarker(tl: Timeline, id: Id) {
  const timeline = tl.markers.find(m => m.id === id)
  if (timeline) return { marker: timeline, clip: undefined, locked: false }
  for (const track of tl.tracks) for (const clip of track.clips) {
    const marker = clip.markers?.find(m => m.id === id)
    if (marker) return { marker, clip, locked: track.locked }
  }
  return null
}
export function visibleMarkers(tl: Timeline, map: (clip: Clip) => TimeMap): { marker: Marker; t: Flicks; clip?: Clip }[] {
  const entries: { marker: Marker; t: Flicks; clip?: Clip }[] = tl.markers.map(marker => ({ marker, t: marker.t }))
  for (const tr of tl.tracks) for (const clip of tr.clips) for (const marker of clip.markers ?? []) {
    const t = clipMarkerTimelineTime(clip, map(clip), marker)
    if (t !== null) entries.push({ marker, t, clip })
  }
  return entries.sort((a, b) => a.t - b.t)
}
/** Normalize known fields in place, retaining unknown kinds, plugin data and future fields. */
export function normalizeProjectMarkers(project: Project): void {
  const normalize = (markers: Marker[]) => {
    for (const marker of markers) {
      marker.t = Number.isFinite(marker.t) ? Math.max(0, Math.round(marker.t)) : 0
      marker.name = typeof marker.name === 'string' ? marker.name : ''
      if (marker.duration !== undefined) marker.duration = Number.isFinite(marker.duration) ? Math.max(0, Math.round(marker.duration)) : 0
    }
  }
  for (const tl of Object.values(project.timelines)) {
    normalize(tl.markers ??= [])
    for (const tr of tl.tracks) for (const c of tr.clips) if (c.markers) normalize(c.markers)
  }
}
