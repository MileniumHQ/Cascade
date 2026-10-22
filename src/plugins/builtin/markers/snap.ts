import type { SnapTargetContribution } from '@core/plugin-api'
import { clipMarkerTimelineTime, visibleMarkers } from '@core/markers'
import type { TimeMap } from '@core/time-remap'
import type { Clip, Id, Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'

/** Marker starts and ends (visible timeline and clip markers) as snap points; `exclude` skips the dragged ones. */
export function markerSnapPoints(tl: Timeline, map: (clip: Clip) => TimeMap, exclude: Set<Id>): Flicks[] {
  const pts: Flicks[] = []
  for (const { marker, t, clip } of visibleMarkers(tl, map)) {
    if (exclude.has(marker.id) || (clip && exclude.has(clip.id))) continue
    pts.push(t)
    if (!marker.duration) continue
    if (!clip) pts.push(t + marker.duration)
    else {
      const end = clipMarkerTimelineTime(clip, map(clip), { ...marker, t: marker.t + marker.duration })
      if (end !== null) pts.push(end)
    }
  }
  return pts
}

export const markerSnapTarget: SnapTargetContribution = {
  id: 'markers',
  points: (app, exclude) => markerSnapPoints(app.timeline(), c => app.edit.timeMap(c), exclude)
}
