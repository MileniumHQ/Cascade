/**
 * Three-point editing as pure logic: resolving which source range lands where, and applying
 * insert / overwrite to timeline data. Media-type neutral — callers build the clips.
 *
 * Of the four points (source in/out, timeline in/out) three decide the edit; the fourth follows.
 * New clips always play at speed 1, so a source range and a timeline range never get stretched
 * to fit each other: when both are marked, the timeline duration wins.
 */
import { clipEnd, type Clip, type Id, type Timeline, type Track, type TrackKind } from '@shared/project'
import type { Flicks } from '@shared/time'
import { insertTime } from './advanced-timeline-ops'
import { placeClip } from './timeline-ops'

/** DataTransfer type carrying a marked source range (`{ sourceIn?, sourceOut?, lanes? }`) next to `application/x-cascade-media`. */
export const SOURCE_RANGE_MIME = 'application/x-cascade-source-range'

export type PlaceMode = 'insert' | 'overwrite' | 'append'

export interface RangeRequest {
  /** Length of the source, or null for media with no intrinsic length (stills, generators). */
  sourceLength: Flicks | null
  /** Duration used when nothing else decides one (unbounded sources with no source out). */
  defaultSpan: Flicks
  sourceIn?: Flicks
  sourceOut?: Flicks
  timelineIn?: Flicks
  timelineOut?: Flicks
  /** Where the edit lands when the timeline has no in/out. */
  playhead: Flicks
  /** Round a time to the project's frame grid. */
  snap?: (t: Flicks) => Flicks
}

export interface ResolvedRange {
  /** Timeline start of the new clip. */
  start: Flicks
  duration: Flicks
  /** Offset into the source where the new clip begins. */
  sourceIn: Flicks
  /** Timeline in+out and a source mark were all set, so the timeline duration decided. */
  fit: boolean
  /** The source ended before the requested range did, so the clip is shorter than asked. */
  shortened: boolean
}

const identity = (t: Flicks) => t

/** Decide start, duration and source offset from whichever of the four points are set. Null when nothing fits. */
export function resolveRange(req: RangeRequest): ResolvedRange | null {
  const snap = req.snap ?? identity
  const len = req.sourceLength ?? Infinity
  const hasIn = req.sourceIn !== undefined
  let sIn = Math.min(Math.max(0, req.sourceIn ?? 0), len)
  // An out at or before the in is ignored, as if it was never marked.
  const sOut = req.sourceOut !== undefined && req.sourceOut > sIn ? Math.min(req.sourceOut, len) : undefined
  const hasOut = sOut !== undefined
  const tIn = req.timelineIn
  const tOut = req.timelineOut !== undefined && (tIn === undefined || req.timelineOut > tIn) ? req.timelineOut : undefined

  let start: Flicks
  let duration: Flicks
  let fit = false

  if (tIn !== undefined && tOut !== undefined) {
    start = tIn
    duration = tOut - tIn
    fit = hasIn || hasOut
    // Only an out mark: the range ends there, so it starts one timeline-duration earlier.
    if (hasOut && !hasIn) sIn = Math.max(0, sOut - duration)
  } else {
    const span = hasOut ? sOut - sIn : req.sourceLength === null ? req.defaultSpan : len - sIn
    duration = span
    if (tOut !== undefined) {
      // Backtimed: the clip ends at the timeline out.
      start = tOut - span
      if (start < 0) {
        // Doesn't fit before 0: drop the head of the source range.
        duration += start
        sIn += -start
        start = 0
      }
    } else {
      start = tIn ?? req.playhead
    }
  }

  start = Math.max(0, snap(start))
  duration = snap(duration)
  let shortened = false
  if (sIn + duration > len) {
    duration = len - sIn
    shortened = true
  }
  if (!(duration > 0)) return null
  return { start, duration, sourceIn: req.sourceLength === null ? 0 : sIn, fit: fit && !shortened, shortened }
}

// ───────────────────────────── applying to a timeline ─────────────────────────────

/** A clip headed for a track. */
export interface Placement {
  trackId: Id
  clip: Clip
}

export interface PlaceResult {
  /** Clips that went in. */
  placed: Id[]
  /** Placements dropped because their track is locked or missing. */
  blocked: Id[]
  /** Clips split at the insert point (right halves created). */
  split: Id[]
}

function usable(tl: Timeline, placements: Placement[]) {
  const ok: { track: Track; clip: Clip }[] = []
  const blocked: Id[] = []
  for (const p of placements) {
    const track = tl.tracks.find((t) => t.id === p.trackId)
    if (!track || track.locked) blocked.push(p.clip.id)
    else ok.push({ track, clip: p.clip })
  }
  // A clip whose link partners were all dropped is no longer linked to anything.
  if (blocked.length) {
    const counts = new Map<Id, number>()
    for (const { clip } of ok) if (clip.linkId) counts.set(clip.linkId, (counts.get(clip.linkId) ?? 0) + 1)
    for (const { clip } of ok) if (clip.linkId && counts.get(clip.linkId)! < 2) clip.linkId = undefined
  }
  return { ok, blocked }
}

/** Put clips in with overwrite semantics: whatever they cover is replaced. Locked tracks are skipped. */
export function overwriteClips(tl: Timeline, placements: Placement[]): PlaceResult {
  const { ok, blocked } = usable(tl, placements)
  for (const { track, clip } of ok) placeClip(track, clip)
  return { placed: ok.map((o) => o.clip.id), blocked, split: [] }
}

/**
 * Open a gap of `duration` at `start` on the target tracks, then put the clips in it.
 * Clips at or after `start` shift right and a clip straddling `start` is split. Link partners of
 * anything that moves open space on their tracks too, so audio and video stay in sync even
 * when only one of them is targeted. A locked linked partner rejects insertion atomically.
 */
export function insertClips(tl: Timeline, placements: Placement[], start: Flicks, duration: Flicks, rippleMarkers = true): PlaceResult {
  const { ok, blocked } = usable(tl, placements)
  if (!ok.length) return { placed: [], blocked, split: [] }
  const before = new Set(tl.tracks.flatMap(tr => tr.clips.map(c => c.id)))
  if (!insertTime(tl, ok.map(o => o.track.id), start, duration, rippleMarkers))
    return { placed: [], blocked: [...blocked, ...ok.map(o => o.clip.id)], split: [] }
  const split = tl.tracks.flatMap(tr => tr.clips.filter(c => !before.has(c.id)).map(c => c.id))
  for (const { track, clip } of ok) placeClip(track, clip)
  return { placed: ok.map((o) => o.clip.id), blocked, split }
}

/** End of the last clip across the given tracks (where an append starts). */
export function endOfTracks(tl: Timeline, trackIds: Id[]): Flicks {
  let end = 0
  for (const track of tl.tracks) {
    if (!trackIds.includes(track.id)) continue
    const last = track.clips[track.clips.length - 1]
    if (last) end = Math.max(end, clipEnd(last))
  }
  return end
}

/**
 * The track a kind of clip lands on: the targeted one, else the first unlocked track of that kind.
 * Undefined when the target is locked or no track of that kind is free.
 */
export function resolveTarget(tl: Timeline, kind: TrackKind, targeted?: Id | null): Track | undefined {
  const t = targeted ? tl.tracks.find((x) => x.id === targeted && x.kind === kind) : undefined
  if (t) return t.locked ? undefined : t
  return tl.tracks.find((x) => x.kind === kind && !x.locked)
}
