/** Generic, mutable pure operations. Call withTimeMaps when a project has remap properties. */
import { clipEnd, findClip, uid, type Clip, type Id, type Timeline, type Track } from '@shared/project'
import type { Flicks } from '@shared/time'
import { shiftMarkers } from './markers'
import { sourceSpan } from './time-remap'
import { expandLinked, MIN_CLIP, sortClips, splitClip, timeMapFor, trimEndTo, trimStartTo, type TrimLimits } from './timeline-ops'

export type LimitsFor = (clip: Clip) => TrimLimits
const unlimited: LimitsFor = () => ({})
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v))) || 0

/** All tracks connected by clips at/after the boundary. Locked partners make an edit atomic. */
export function linkedTrackClosure(tl: Timeline, trackIds: Iterable<Id>, at: Flicks): Set<Id> {
  const out = new Set(trackIds)
  let changed = true
  while (changed) {
    changed = false
    const links = new Set(tl.tracks.filter((tr) => out.has(tr.id)).flatMap((tr) => tr.clips.filter((c) => clipEnd(c) > at && c.linkId).map((c) => c.linkId!)))
    for (const tr of tl.tracks) if (!out.has(tr.id) && tr.clips.some((c) => c.linkId && links.has(c.linkId))) {
      out.add(tr.id)
      changed = true
    }
  }
  return out
}

/** Linked members must fall on the same side of an edit boundary. */
function matchingLinkPartitions(tl: Timeline, tracks: Set<Id>, at: Flicks, split: boolean, except: Set<Id> = new Set(), boundaries = new Map<Id, Flicks>()): boolean {
  const partitions = new Map<Id, number>()
  for (const tr of tl.tracks) for (const c of tr.clips) {
    if (!c.linkId || except.has(c.id)) continue
    const boundary = boundaries.get(tr.id) ?? at
    const partition = !tracks.has(tr.id) || clipEnd(c) <= boundary ? 0 : c.start >= boundary ? 2 : split ? 1 : 0
    const prior = partitions.get(c.linkId)
    if (prior !== undefined && prior !== partition) return false
    partitions.set(c.linkId, partition)
  }
  return true
}

/** Insert empty time; split straddling clips and preserve links between their right halves. */
export function insertTime(tl: Timeline, trackIds: Iterable<Id>, at: Flicks, duration: Flicks, rippleMarkers = true): boolean {
  if (!Number.isSafeInteger(at) || at < 0 || duration <= 0 || !Number.isSafeInteger(duration)) return false
  const tracks = linkedTrackClosure(tl, trackIds, at)
  if (tl.tracks.some((tr) => tracks.has(tr.id) && tr.locked) || !matchingLinkPartitions(tl, tracks, at, true)) return false
  // Do not create an unsplittable sliver on either side of the insertion.
  if (tl.tracks.some((tr) => tracks.has(tr.id) && tr.clips.some((c) => c.start < at && clipEnd(c) > at && (at - c.start <= MIN_CLIP / 2 || clipEnd(c) - at <= MIN_CLIP / 2)))) return false
  const links = new Map<Id, Id>()
  for (const tr of tl.tracks.filter((tr) => tracks.has(tr.id))) {
    const spanning = tr.clips.find((c) => c.start < at && clipEnd(c) > at)
    if (spanning) {
      const right = splitClip(tr, spanning.id, at)!
      if (right.linkId) {
        if (!links.has(right.linkId)) links.set(right.linkId, uid('ln_'))
        right.linkId = links.get(right.linkId)
      }
    }
    for (const c of tr.clips) if (c.start >= at) c.start += duration
  }
  if (rippleMarkers) tl.markers = shiftMarkers(tl.markers, at, duration)
  return true
}

/** Source-limited edge bounds without neighbour restrictions. */
function edgeBounds(c: Clip, edge: 'start' | 'end', limits: TrimLimits): [number, number] {
  const map = timeMapFor(c)
  if (edge === 'start') {
    let lo = 0
    if (limits.sourceDuration !== undefined && map.max > 0) lo = Math.max(lo, c.start + map.localAt(map.reversed ? limits.sourceDuration - c.sourceIn : -c.sourceIn))
    return [lo, clipEnd(c) - MIN_CLIP]
  }
  let hi = Number.MAX_SAFE_INTEGER
  if (limits.sourceDuration !== undefined && map.max > 0) hi = Math.min(hi, c.start + map.localAt(map.reversed ? -c.sourceIn : limits.sourceDuration - c.sourceIn))
  return [c.start + MIN_CLIP, hi]
}

/** Ripple a linked group's trim by one common, source-limited delta. Returns the applied edge delta. */
export function rippleTrim(tl: Timeline, clipId: Id, edge: 'start' | 'end', t: Flicks, opts: { limits?: LimitsFor; linked?: boolean; rippleMarkers?: boolean } = {}): Flicks {
  const f = findClip(tl, clipId)
  if (!f) return 0
  const limits = opts.limits ?? unlimited
  const ids = opts.linked === false ? new Set([clipId]) : expandLinked(tl, [clipId])
  const group = [...ids].map((id) => findClip(tl, id)!).filter(Boolean)
  if (group.some((g) => g.track.locked) || new Set(group.map((g) => g.track.id)).size !== group.length) return 0
  const boundary = Math.min(...group.map((g) => clipEnd(g.clip)))
  const boundaries = new Map(group.map((g) => [g.track.id, clipEnd(g.clip)]))
  const tracks = linkedTrackClosure(tl, group.map((g) => g.track.id), boundary)
  if (tl.tracks.some((tr) => tracks.has(tr.id) && tr.locked) || !matchingLinkPartitions(tl, tracks, boundary, false, ids, boundaries)) return 0
  // A tail crossing a different group's edge cannot ripple without splitting its content.
  if (tl.tracks.some((tr) => tracks.has(tr.id) && tr.clips.some((c) => !ids.has(c.id) && c.start < (boundaries.get(tr.id) ?? boundary) && clipEnd(c) > (boundaries.get(tr.id) ?? boundary)))) return 0
  let lo = -Infinity, hi = Infinity
  for (const g of group) {
    const base = edge === 'start' ? g.clip.start : clipEnd(g.clip)
    let [a, b] = edgeBounds(g.clip, edge, limits(g.clip))
    // The virtual head trim can extend before zero: its timeline start stays fixed.
    if (edge === 'start') {
      const map = timeMapFor(g.clip)
      const duration = limits(g.clip).sourceDuration
      a = duration !== undefined && map.max > 0 ? g.clip.start + map.localAt(map.reversed ? duration - g.clip.sourceIn : -g.clip.sourceIn) : -Number.MAX_SAFE_INTEGER
    }
    lo = Math.max(lo, a - base)
    hi = Math.min(hi, b - base)
  }
  // Tail tracks without a trimmed member must have enough empty space for a left shift.
  for (const tr of tl.tracks.filter((tr) => tracks.has(tr.id) && !group.some((g) => g.track.id === tr.id))) {
    const before = tr.clips.filter((c) => clipEnd(c) <= boundary).at(-1)
    const after = tr.clips.find((c) => c.start >= boundary)
    if (after) {
      const room = after.start - (before ? clipEnd(before) : 0)
      if (edge === 'end') lo = Math.max(lo, -room)
      else hi = Math.min(hi, room)
    }
  }
  if (lo > hi) return 0
  const base = edge === 'start' ? f.clip.start : clipEnd(f.clip)
  const delta = clamp(t - base, lo, hi)
  const markerAt = edge === 'start' ? f.clip.start : clipEnd(f.clip)
  const shift = edge === 'start' ? -delta : delta
  for (const g of group) {
    if (edge === 'start') {
      const start = g.clip.start
      trimStartTo(g.clip, start + delta)
      g.clip.start = start
    } else trimEndTo(g.clip, clipEnd(g.clip) + delta)
  }
  for (const tr of tl.tracks.filter((tr) => tracks.has(tr.id))) {
    for (const c of tr.clips) if (!ids.has(c.id) && c.start >= (boundaries.get(tr.id) ?? boundary)) c.start += shift
    sortClips(tr)
  }
  if (opts.rippleMarkers !== false) tl.markers = shiftMarkers(tl.markers, shift < 0 && edge === 'end' ? markerAt + shift : markerAt, shift)
  return delta
}

/** Move a shared cut, keeping the outside edges fixed. Returns the actual cut delta. */
export function rollEdit(track: Track, leftId: Id, rightId: Id, t: Flicks, limits: LimitsFor = unlimited): Flicks {
  const i = track.clips.findIndex((c) => c.id === leftId)
  const left = track.clips[i], right = track.clips[i + 1]
  if (track.locked || !left || right?.id !== rightId || clipEnd(left) !== right.start) return 0
  const [la, lb] = edgeBounds(left, 'end', limits(left))
  const [ra, rb] = edgeBounds(right, 'start', limits(right))
  if (Math.max(la, ra) > Math.min(lb, rb)) return 0
  const cut = clamp(t, Math.max(la, ra), Math.min(lb, rb))
  const delta = cut - right.start
  trimEndTo(left, cut)
  trimStartTo(right, cut)
  return delta
}

/** Slip content by timeline delta beneath fixed edges, with integral time-map source bounds. */
export function slipClip(clip: Clip, delta: Flicks, limits: TrimLimits = {}): Flicks {
  const map = timeMapFor(clip)
  const span = sourceSpan(clip, map)
  const low = -span.lo
  const high = limits.sourceDuration === undefined ? Infinity : limits.sourceDuration - span.hi
  if (low > high || map.max === 0) return 0
  const offset = clamp(map.offset(delta), low, high)
  clip.sourceIn += offset
  return Math.round(map.localAt(offset))
}

/** Move a clip between touching neighbours, trimming their inside edges. */
export function slideClip(track: Track, clipId: Id, delta: Flicks, limits: LimitsFor = unlimited): Flicks {
  const i = track.clips.findIndex((c) => c.id === clipId)
  const c = track.clips[i], left = track.clips[i - 1], right = track.clips[i + 1]
  if (track.locked || !c || !left || !right || clipEnd(left) !== c.start || clipEnd(c) !== right.start) return 0
  const [la, lb] = edgeBounds(left, 'end', limits(left))
  const [ra, rb] = edgeBounds(right, 'start', limits(right))
  if (Math.max(la - c.start, ra - right.start) > Math.min(lb - c.start, rb - right.start)) return 0
  const d = clamp(delta, Math.max(la - c.start, ra - right.start), Math.min(lb - c.start, rb - right.start))
  trimEndTo(left, c.start + d)
  c.start += d
  trimStartTo(right, right.start + d)
  return d
}

/** Close precisely the same empty interval on all linked tail tracks, or leave all untouched. */
export function closeLinkedGap(tl: Timeline, trackId: Id, t: Flicks, rippleMarkers = true): boolean {
  const track = tl.tracks.find((tr) => tr.id === trackId)
  if (!track || track.locked || track.clips.some((c) => c.start <= t && clipEnd(c) > t)) return false
  const end = track.clips.find((c) => c.start > t)?.start
  const start = Math.max(0, ...track.clips.filter((c) => clipEnd(c) <= t).map(clipEnd))
  if (end === undefined || end <= start) return false
  const tracks = linkedTrackClosure(tl, [trackId], end)
  if (!matchingLinkPartitions(tl, tracks, end, false)) return false
  if (tl.tracks.some((tr) => tracks.has(tr.id) && (tr.locked || tr.clips.some((c) => c.start < end && clipEnd(c) > start)))) return false
  for (const tr of tl.tracks.filter((tr) => tracks.has(tr.id))) for (const c of tr.clips) if (c.start >= end) c.start -= end - start
  if (rippleMarkers) tl.markers = shiftMarkers(tl.markers, start, start - end)
  return true
}
