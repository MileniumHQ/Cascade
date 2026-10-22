/** Pure composition transforms. The caller supplies a plugin-built wrapper; no type ids here. */
import { clipEnd, findClip, uid, type Clip, type Id, type Timeline, type Track } from '@shared/project'
import { anySolo, trackAudible } from '@shared/audio-mix'
import type { TimeMap } from './time-remap'
import { cloneClip, expandLinked, trimEndTo, trimStartTo, withTimeMaps } from './timeline-ops'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** Copy all identities, preserving plugin data and remapping linked clips/transitions. */
export function cloneTimeline(source: Timeline, name = `${source.name} copy`): Timeline {
  const timeline = copy(source)
  timeline.id = uid('tl_')
  timeline.name = name
  const clips = new Map<Id, Id>(), links = new Map<Id, Id>()
  const link = (id: Id) => { if (!links.has(id)) links.set(id, uid('ln_')); return links.get(id)! }
  for (const track of timeline.tracks) {
    track.id = uid('tr_')
    track.clips = track.clips.map(c => {
      const cloned = cloneClip(c)
      clips.set(c.id, cloned.id)
      if (cloned.linkId) cloned.linkId = link(cloned.linkId)
      return cloned
    })
  }
  for (const track of timeline.tracks) for (const tx of track.transitions ?? []) {
    tx.id = uid('tx_')
    if (tx.from) tx.from = clips.get(tx.from)
    if (tx.to) tx.to = clips.get(tx.to)
    if (tx.linkId) tx.linkId = link(tx.linkId)
  }
  for (const marker of timeline.markers) marker.id = uid('mk_')
  return timeline
}

export function nestReason(timeline: Timeline, ids: Iterable<Id>): string | null {
  const selected = expandLinked(timeline, ids)
  const found = [...selected].flatMap(id => { const f = findClip(timeline, id); return f ? [f] : [] })
  if (!found.length) return 'Select clips to nest'
  if (found.some(f => f.track.locked)) return 'Unlock the selected tracks first'
  const start = Math.min(...found.map(f => f.clip.start)), end = Math.max(...found.map(f => clipEnd(f.clip)))
  const host = timeline.tracks.find(t => t.kind === 'visual' && t.clips.some(c => selected.has(c.id)))
  if (host && (host.hidden || host.muted || host.gain || host.pan)) return 'Reset the lowest selected video track’s visibility and mix settings before nesting'
  if (host?.clips.some(c => !selected.has(c.id) && c.start < end && clipEnd(c) > start))
    return 'Include the other clips on the lowest selected video track'
  // Moving a clip across a transition boundary would silently remove that transition.
  if (timeline.tracks.some(t => t.transitions?.some(tx => tx.from && tx.to && selected.has(tx.from) !== selected.has(tx.to))))
    return 'Include both sides of transitions before nesting'
  return null
}

export function nestClips(timeline: Timeline, ids: Iterable<Id>, wrapper: Clip, nestedId: Id, name: string): Timeline | null {
  if (nestReason(timeline, ids)) return null
  const selected = expandLinked(timeline, ids)
  const found = [...selected].flatMap(id => { const f = findClip(timeline, id); return f ? [f] : [] })
  const start = Math.min(...found.map(f => f.clip.start)), end = Math.max(...found.map(f => clipEnd(f.clip)))
  const nested: Timeline = { id: nestedId, name, tracks: [], markers: [] }
  let host = timeline.tracks.find(t => t.kind === 'visual' && t.clips.some(c => selected.has(c.id)))
  if (!host) {
    host = { id: uid('tr_'), name: 'V1', kind: 'visual', hidden: false, muted: false, locked: false, clips: [] }
    timeline.tracks.unshift(host)
  }
  for (const track of timeline.tracks) {
    const inner = copy(track)
    inner.id = uid('tr_')
    inner.clips = inner.clips.filter(c => selected.has(c.id)).map(c => ({ ...c, start: c.start - start }))
    inner.transitions = inner.transitions?.filter(tx => (!tx.from || selected.has(tx.from)) && (!tx.to || selected.has(tx.to)))
    nested.tracks.push(inner)
    track.clips = track.clips.filter(c => !selected.has(c.id))
    track.transitions = track.transitions?.filter(tx => (!tx.from || !selected.has(tx.from)) && (!tx.to || !selected.has(tx.to)))
  }
  wrapper.start = start
  wrapper.duration = end - start
  wrapper.sourceIn = 0
  host.clips.push(wrapper)
  host.clips.sort((a, b) => a.start - b.start)
  return nested
}

/** Expand into fresh tracks, preserving each nested track's bus settings and stacking order.
 * Uses the caller's scoped time maps for trims. The nested source is never mutated. */
export function breakApart(timeline: Timeline, wrapperId: Id, source: Timeline, timeMap?: (clip: Clip) => TimeMap): Id[] | null {
  const found = findClip(timeline, wrapperId)
  if (!found || found.track.locked) return null
  const wrapper = found.clip, from = wrapper.sourceIn, to = from + wrapper.duration
  const nested = cloneTimeline(source)
  const maps = new Map<Id, TimeMap>()
  if (timeMap) for (let i = 0; i < source.tracks.length; i++)
    for (let j = 0; j < source.tracks[i].clips.length; j++)
      maps.set(nested.tracks[i].clips[j].id, timeMap(source.tracks[i].clips[j]))
  const nestedSolo = anySolo(source.tracks), parentSolo = anySolo(timeline.tracks)
  const ids: Id[] = []
  const tracks: Track[] = []
  for (const track of nested.tracks) {
    if (track.kind === 'audio') {
      track.muted = !trackAudible(track, nestedSolo)
      track.solo = parentSolo
    }
    track.clips = track.clips.filter(c => c.start < to && clipEnd(c) > from)
    for (const clip of track.clips) {
      if (clip.start < from) {
        const map = maps.get(clip.id)
        if (map) withTimeMaps(() => map, () => trimStartTo(clip, from))
        else trimStartTo(clip, from)
      }
      if (clipEnd(clip) > to) trimEndTo(clip, to)
      clip.start += wrapper.start - from
      ids.push(clip.id)
    }
    const alive = new Set(track.clips.map(c => c.id))
    track.transitions = track.transitions?.filter(tx => (!tx.from || alive.has(tx.from)) && (!tx.to || alive.has(tx.to)))
    if (track.clips.length) tracks.push(track)
  }
  found.track.clips.splice(found.index, 1)
  found.track.transitions = found.track.transitions?.filter(tx => tx.from !== wrapperId && tx.to !== wrapperId)
  const visual = tracks.filter(t => t.kind === 'visual'), audio = tracks.filter(t => t.kind === 'audio')
  timeline.tracks.splice(timeline.tracks.indexOf(found.track) + 1, 0, ...visual)
  timeline.tracks.push(...audio)
  return ids
}
