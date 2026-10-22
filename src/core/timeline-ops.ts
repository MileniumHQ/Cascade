/**
 * Pure editing operations on timeline data (work on immer drafts or plain objects).
 * DaVinci-style semantics: clips on a track never overlap; placing a clip overwrites whatever
 * is underneath (trimming, splitting or removing it).
 */
import { clipEnd, uid, type Clip, type Id, type Timeline, type Track } from '@shared/project'
import type { Flicks } from '@shared/time'
import { constantMap, type TimeMap } from './time-remap'

export const MIN_CLIP: Flicks = 705_600_000 / 240

/** How clip-local time maps to source time; the editor scopes one aware of keyframed speed. */
const constantResolver = (clip: Clip) => constantMap(clip.speed ?? 1)
let resolveTimeMap: (clip: Clip) => TimeMap = constantResolver
/** Run `body` with `fn` resolving time maps for trims and splits (scoped: several apps may coexist). */
export function withTimeMaps<T>(fn: (clip: Clip) => TimeMap, body: () => T): T {
  const prev = resolveTimeMap
  resolveTimeMap = fn
  try {
    return body()
  } finally {
    resolveTimeMap = prev
  }
}

export function sortClips(track: Track) {
  track.clips.sort((a, b) => a.start - b.start)
}

/** Shift a clip's keyframes by -delta (used when trimming the start so animation stays put). */
function shiftKeyframes(clip: Clip, delta: Flicks) {
  if (!delta) return
  for (const p of clip.properties)
    for (const pv of Object.values(p.params)) if (pv.keyframes) for (const k of pv.keyframes) k.t -= delta
}

/** Move the clip's start edge to `newStart` keeping the content in place (trim in). */
export function trimStartTo(clip: Clip, newStart: Flicks) {
  const delta = newStart - clip.start
  const map = resolveTimeMap(clip)
  clip.start = newStart
  clip.duration -= delta
  // offset() extrapolates below 0 at the first speed, so trimming outwards works too.
  clip.sourceIn += Math.round(map.offset(delta))
  shiftKeyframes(clip, delta)
}

export function trimEndTo(clip: Clip, newEnd: Flicks) {
  clip.duration = newEnd - clip.start
}

export function cloneClip(clip: Clip): Clip {
  const c = JSON.parse(JSON.stringify(clip)) as Clip
  c.id = uid('cl_')
  for (const p of c.properties) {
    p.id = uid('pi_')
    for (const pv of Object.values(p.params)) for (const k of pv.keyframes ?? []) k.id = uid('kf_')
  }
  return c
}

/**
 * Clear [start, end) on a track (overwrite semantics). Clips fully inside are removed, partially
 * covered clips are trimmed, a clip spanning the whole range is split in two.
 * Returns ids of removed clips and any new clips created by splits.
 */
export function clearRange(track: Track, start: Flicks, end: Flicks, except: Set<Id> = new Set()) {
  const removed: Id[] = []
  const created: Clip[] = []
  const next: Clip[] = []
  for (const c of track.clips) {
    const cs = c.start
    const ce = clipEnd(c)
    if (except.has(c.id) || ce <= start || cs >= end) {
      next.push(c)
      continue
    }
    if (cs >= start && ce <= end) {
      removed.push(c.id)
      continue
    }
    if (cs < start && ce > end) {
      const right = cloneClip(c)
      trimEndTo(c, start)
      trimStartTo(right, end)
      if (c.linkId) right.linkId = undefined
      next.push(c, right)
      created.push(right)
      continue
    }
    if (cs < start) trimEndTo(c, start)
    else trimStartTo(c, end)
    next.push(c)
  }
  track.clips = next
  sortClips(track)
  return { removed, created }
}

/** Insert a clip with overwrite semantics. */
export function placeClip(track: Track, clip: Clip) {
  clip.start = Math.max(0, clip.start)
  const res = clearRange(track, clip.start, clipEnd(clip), new Set([clip.id]))
  if (!track.clips.includes(clip)) track.clips.push(clip)
  sortClips(track)
  return res
}

/** Split a clip at timeline time `t`. Returns the new right-hand clip (or null if t is outside). */
export function splitClip(track: Track, clipId: Id, t: Flicks): Clip | null {
  const i = track.clips.findIndex((c) => c.id === clipId)
  if (i < 0) return null
  const c = track.clips[i]
  if (t <= c.start + MIN_CLIP / 2 || t >= clipEnd(c) - MIN_CLIP / 2) return null
  const right = cloneClip(c)
  trimEndTo(c, t)
  trimStartTo(right, t)
  // Keyframes: keep only those within each half, but preserve keyframes beyond the edge as
  // they still affect interpolation — trimming is non-destructive, so we keep all of them.
  track.clips.splice(i + 1, 0, right)
  return right
}

export interface TrimLimits {
  /** Max source duration (time-based media), in flicks of source time. */
  sourceDuration?: Flicks
}

/** Trim an edge to `t`, clamped to neighbours and source media length. */
export function trimClip(track: Track, clipId: Id, edge: 'start' | 'end', t: Flicks, limits: TrimLimits = {}) {
  const i = track.clips.findIndex((c) => c.id === clipId)
  if (i < 0) return
  const c = track.clips[i]
  const map = resolveTimeMap(c)
  if (edge === 'start') {
    const prev = track.clips[i - 1]
    let min = prev ? clipEnd(prev) : 0
    // Reversed clips run down from sourceIn, so extending the start raises it towards the source end.
    if (limits.sourceDuration !== undefined && map.max > 0) min = Math.max(min, c.start + map.localAt(map.reversed ? limits.sourceDuration - c.sourceIn : -c.sourceIn))
    const max = clipEnd(c) - MIN_CLIP
    trimStartTo(c, Math.round(Math.min(max, Math.max(min, t))))
  } else {
    const next = track.clips[i + 1]
    let max = next ? next.start : Number.MAX_SAFE_INTEGER
    if (limits.sourceDuration !== undefined && map.max > 0) max = Math.min(max, c.start + map.localAt(map.reversed ? -c.sourceIn : limits.sourceDuration - c.sourceIn))
    const min = c.start + MIN_CLIP
    trimEndTo(c, Math.round(Math.max(min, Math.min(max, t))))
  }
}

/** Remove clips; with ripple, close the gap on their tracks. */
export function deleteClips(tl: Timeline, ids: Set<Id>, ripple = false) {
  for (const track of tl.tracks) {
    const gone = track.clips.filter((c) => ids.has(c.id))
    if (!gone.length) continue
    track.clips = track.clips.filter((c) => !ids.has(c.id))
    if (ripple) {
      // process from the right so shifts don't compound incorrectly
      for (const g of gone.sort((a, b) => b.start - a.start)) {
        for (const c of track.clips) if (c.start >= clipEnd(g)) c.start -= g.duration
      }
    }
  }
}

/** Remove the gap at time t on a track (ripple everything after it left). */
export function closeGap(track: Track, t: Flicks) {
  let gapStart = 0
  let gapEnd: Flicks | null = null
  for (const c of track.clips) {
    if (c.start > t) {
      gapEnd = c.start
      break
    }
    gapStart = Math.max(gapStart, clipEnd(c))
  }
  if (gapEnd === null || gapStart > t) return
  const d = gapEnd - gapStart
  for (const c of track.clips) if (c.start >= gapEnd) c.start -= d
}

export interface MoveRequest {
  clipId: Id
  /** New start (timeline flicks). */
  start: Flicks
  /** Destination track id. */
  trackId: Id
}

/**
 * Move clips (committing a drag). Clips are lifted from their tracks first, then placed with
 * overwrite semantics, so moved clips can overlap each other's old positions freely.
 */
export function moveClips(tl: Timeline, moves: MoveRequest[]) {
  const lifted: { clip: Clip; req: MoveRequest }[] = []
  const ids = new Set(moves.map((m) => m.clipId))
  for (const track of tl.tracks) {
    for (const c of track.clips) {
      if (ids.has(c.id)) lifted.push({ clip: c, req: moves.find((m) => m.clipId === c.id)! })
    }
    track.clips = track.clips.filter((c) => !ids.has(c.id))
  }
  for (const { clip, req } of lifted) {
    const dest = tl.tracks.find((t) => t.id === req.trackId)
    if (!dest) continue
    clip.start = Math.max(0, Math.round(req.start))
    placeClip(dest, clip)
  }
}

/** All clip ids linked to any of `ids` (including themselves). */
export function expandLinked(tl: Timeline, ids: Iterable<Id>): Set<Id> {
  const out = new Set(ids)
  const links = new Set<string>()
  for (const tr of tl.tracks) for (const c of tr.clips) if (out.has(c.id) && c.linkId) links.add(c.linkId)
  if (links.size) for (const tr of tl.tracks) for (const c of tr.clips) if (c.linkId && links.has(c.linkId)) out.add(c.id)
  return out
}

/** Clips active at time t on a track (binary search; clips sorted & non-overlapping). */
export function clipAt(track: Track, t: Flicks): Clip | undefined {
  const cs = track.clips
  let lo = 0
  let hi = cs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = cs[mid]
    if (t < c.start) hi = mid - 1
    else if (t >= clipEnd(c)) lo = mid + 1
    else return c
  }
  return undefined
}

/** Clips overlapping [a, b) on a track. */
export function clipsInRange(track: Track, a: Flicks, b: Flicks): Clip[] {
  const out: Clip[] = []
  for (const c of track.clips) {
    if (c.start >= b) break
    if (clipEnd(c) > a) out.push(c)
  }
  return out
}

/** Snap candidates: clip edges, playhead, markers. */
export function snapPoints(tl: Timeline, exclude: Set<Id>, extra: Flicks[] = []): Flicks[] {
  const pts = new Set<Flicks>([0, ...extra])
  for (const tr of tl.tracks) for (const c of tr.clips) if (!exclude.has(c.id)) pts.add(c.start).add(clipEnd(c))
  for (const m of tl.markers) pts.add(m.t)
  return [...pts].sort((a, b) => a - b)
}

export function snapTime(t: Flicks, points: Flicks[], threshold: Flicks): { t: Flicks; snapped: boolean; to?: Flicks } {
  let best: Flicks | undefined
  let bestD = threshold
  for (const p of points) {
    const d = Math.abs(p - t)
    if (d <= bestD) {
      bestD = d
      best = p
    }
  }
  return best === undefined ? { t, snapped: false } : { t: best, snapped: true, to: best }
}

/** Resolve the scoped time map, including plugin-provided speed curves. */
export const timeMapFor = (clip: Clip): TimeMap => resolveTimeMap(clip)

export { rippleTrim, rollEdit, slipClip, slideClip, insertTime, closeLinkedGap, linkedTrackClosure } from './advanced-timeline-ops'
export type { LimitsFor } from './advanced-timeline-ops'
