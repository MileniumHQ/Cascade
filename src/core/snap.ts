import type { Id } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { CascadeAPI } from './app'
import { snapPoints, withTimeMaps } from './timeline-ops'

/**
 * Every point a timeline drag can snap to: clip edges, zero, `extra` (the playhead…) and whatever the
 * `snapTargets` providers contribute (markers, beat grids…). A failing provider is skipped.
 */
export function collectSnapPoints(app: CascadeAPI, exclude: Set<Id>, extra: Flicks[] = []): Flicks[] {
  const pts = new Set(withTimeMaps(c => app.edit.timeMap(c), () => snapPoints(app.timeline(), exclude, extra)))
  for (const provider of app.registries.snapTargets.all()) {
    try { for (const p of provider.points(app, exclude)) if (Number.isFinite(p)) pts.add(Math.round(p)) } catch (e) { console.error(`[snap] ${provider.id} failed`, e) }
  }
  return [...pts].sort((a, b) => a - b)
}
