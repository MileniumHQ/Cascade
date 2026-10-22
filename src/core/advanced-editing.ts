import type { CascadeAPI } from './app'
import { clipEnd, findClip, type Clip, type Id, type Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'
import { clipTimeMap } from './time-remap'
import { shiftMarkers } from './markers'
import * as ops from './timeline-ops'

export type TrimTool = 'roll' | 'slip' | 'slide'
export const sourceLimits = (app: CascadeAPI, c: Clip): ops.TrimLimits => {
  const m = c.mediaId ? app.project().media[c.mediaId] : undefined
  return app.registries.mediaTypes.get(c.type)?.timeBased && m?.meta.duration !== undefined ? { sourceDuration: m.meta.duration } : {}
}

/** Verify every member of each existing link group received the same edge/source changes. */
function linksStayTogether(before: Timeline, after: Timeline): boolean {
  const changes = new Map<Id, string>()
  for (const tr of before.tracks) for (const c of tr.clips) {
    if (!c.linkId) continue
    const next = findClip(after, c.id)?.clip
    if (!next) continue
    const signature = JSON.stringify([next.start - c.start, next.duration - c.duration, next.sourceIn - c.sourceIn])
    const prior = changes.get(c.linkId)
    if (prior !== undefined && prior !== signature) return false
    changes.set(c.linkId, signature)
  }
  return true
}

/** Plan linked tool edits before changing a draft, so mismatched/locked neighbours never desync. */
export function linkedToolEdit(app: CascadeAPI, tl: Timeline, tool: TrimTool, id: Id, amount: Flicks, edge: 'start' | 'end' = 'end', linked = true): Flicks {
  const before = JSON.parse(JSON.stringify(tl)) as Timeline
  const ids = linked ? ops.expandLinked(before, [id]) : new Set([id])
  const group = [...ids].map((cid) => findClip(before, cid)).filter((f): f is NonNullable<typeof f> => !!f)
  if (!group.length || group.some((f) => f.track.locked)) return 0
  const limits = (c: Clip) => sourceLimits(app, c)
  const maps = new Map(before.tracks.flatMap((tr) => tr.clips.map((c) => [c.id, clipTimeMap(c, before, app.registries)] as const)))
  const run = (target: Timeline, cid: Id, delta: Flicks): Flicks => {
    const f = findClip(target, cid)!
    if (tool === 'slip') return ops.slipClip(f.clip, delta, limits(f.clip))
    if (tool === 'slide') return ops.slideClip(f.track, cid, delta, limits)
    const left = edge === 'start' ? f.track.clips[f.index - 1] : f.clip
    const right = edge === 'start' ? f.clip : f.track.clips[f.index + 1]
    return left && right ? ops.rollEdit(f.track, left.id, right.id, right.start + delta, limits) : 0
  }
  return ops.withTimeMaps((c) => maps.get(c.id) ?? app.edit.timeMap(c), () => {
    let delta = amount
    for (const cid of ids) {
      const probe = JSON.parse(JSON.stringify(before)) as Timeline
      const allowed = run(probe, cid, amount)
      delta = amount < 0 ? Math.max(delta, allowed) : Math.min(delta, allowed)
    }
    if (!delta) return 0
    const trial = JSON.parse(JSON.stringify(before)) as Timeline
    for (const cid of ids) run(trial, cid, delta)
    if (linked && !linksStayTogether(before, trial)) return 0
    // Locked linked neighbours must stay unchanged even with linked selection disabled.
    if (before.tracks.some((tr) => tr.locked && JSON.stringify(tr) !== JSON.stringify(trial.tracks.find((t) => t.id === tr.id)))) return 0
    for (let i = 0; i < tl.tracks.length; i++) if (JSON.stringify(before.tracks[i]) !== JSON.stringify(trial.tracks[i])) tl.tracks[i] = trial.tracks[i]
    return delta
  })
}

/** Ripple removed intervals onto linked tail tracks without deleting unrelated content. */
export function deleteWithRipple(tl: Timeline, ids: Set<Id>, rippleMarkers = true): boolean {
  if (tl.tracks.some((tr) => tr.locked && tr.clips.some((c) => ids.has(c.id)))) return false
  const removed = tl.tracks.flatMap(tr => tr.clips.filter(c => ids.has(c.id)).map(c => ({ start: c.start, end: clipEnd(c) }))).sort((a, b) => a.start - b.start)
  const union: { start: number; end: number }[] = []
  for (const range of removed) {
    const last = union.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else union.push({ ...range })
  }
  const ripple = () => { if (rippleMarkers) for (const range of [...union].reverse()) tl.markers = shiftMarkers(tl.markers, range.start, range.start - range.end) }
  const local = JSON.parse(JSON.stringify(tl)) as Timeline
  ops.deleteClips(local, ids, true)
  // Usually every linked track has its own selected member. Prefer each track's own
  // removed durations, so offset linked clips do not remove the same time twice.
  if (linksStayTogether(tl, local)) {
    for (let i = 0; i < tl.tracks.length; i++) if (JSON.stringify(tl.tracks[i]) !== JSON.stringify(local.tracks[i])) tl.tracks[i] = local.tracks[i]
    ripple()
    return true
  }
  const trial = JSON.parse(JSON.stringify(tl)) as Timeline
  const intervals = new Map<string, { start: number; end: number; tracks: Set<Id> }>()
  for (const tr of trial.tracks) for (const c of tr.clips) if (ids.has(c.id)) {
    const key = `${c.start}:${clipEnd(c)}`
    let entry = intervals.get(key)
    if (!entry) intervals.set(key, entry = { start: c.start, end: clipEnd(c), tracks: new Set() })
    entry.tracks.add(tr.id)
  }
  if (!intervals.size) return false
  ops.deleteClips(trial, ids)
  // Union overlapping removed intervals on connected tracks, then close from right to left.
  const ranges = [...intervals.values()]
  for (const range of ranges) range.tracks = ops.linkedTrackClosure(tl, range.tracks, range.end)
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j]
      if (a.start <= b.end && b.start <= a.end && [...a.tracks].some((id) => b.tracks.has(id))) {
        a.start = Math.min(a.start, b.start)
        a.end = Math.max(a.end, b.end)
        a.tracks = new Set([...a.tracks, ...b.tracks])
        ranges.splice(j, 1)
        merged = true
        break outer
      }
    }
  }
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    const tracks = range.tracks
    if (trial.tracks.some((tr) => tracks.has(tr.id) && (tr.locked || tr.clips.some((c) => c.start < range.end && clipEnd(c) > range.start)))) return false
    for (const tr of trial.tracks.filter((tr) => tracks.has(tr.id))) for (const c of tr.clips) if (c.start >= range.end) c.start -= range.end - range.start
  }
  if (!linksStayTogether(tl, trial)) return false
  tl.tracks = trial.tracks
  ripple()
  return true
}
