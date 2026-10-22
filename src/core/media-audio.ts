import type { Registries } from './app'
import { timelineDuration, type Clip, type Id, type Project, type Timeline, type Track } from '@shared/project'
import type { Flicks } from '@shared/time'
import { anySolo, trackAudible } from '@shared/audio-mix'
import { clipTimeMap, sourceLocalRange } from './time-remap'
import { transitionClipRange } from './transitions'
import { sourceMeta, timelineDependencies } from './compositions'

type Range = { start: Flicks; end: Flicks }
const MAX_DEPTH = 64

/** The clip-local range of `clip` that can sound inside `range`, or null if nothing can. */
function clipAudioQuery(project: Project, registries: Registries, tl: Timeline, track: Track, clip: Clip, range: Range) {
  const mt = registries.mediaTypes.get(clip.type)
  const active = transitionClipRange(track, clip, tx => !!registries.transitions.get(tx.type)?.kinds.includes(track.kind))
  const remap = clipTimeMap(clip, tl, registries)
  if (remap.max === 0) return null
  const original = clip.mediaId ? project.media[clip.mediaId] : undefined
  const media = original && { ...original, meta: sourceMeta(original, project, registries) }
  const available = sourceLocalRange(clip, remap, media?.meta.duration)
  const localRange = {
    start: Math.max(range.start, active.start, clip.start + available.start) - clip.start,
    end: Math.min(range.end, active.end, clip.start + available.end) - clip.start
  }
  return localRange.end <= localRange.start ? null : { mt, media, remap, localRange }
}
const audibleTracks = (tl: Timeline) => {
  const solo = anySolo(tl.tracks)
  return tl.tracks.filter(track => trackAudible(track, solo) && !(track.kind === 'visual' && track.hidden))
}

/** Plugin-driven audio detection, including visual media that carries its own sound. */
export function timelineHasAudio(project: Project, registries: Registries, timelineId: Id,
  range: Range, ancestors: readonly Id[] = []): boolean {
  const tl = project.timelines[timelineId]
  if (!tl || ancestors.includes(timelineId) || ancestors.length >= MAX_DEPTH || range.end <= range.start) return false
  const path = [...ancestors, timelineId]
  return audibleTracks(tl).some(track => track.clips.some(clip => {
    const q = clipAudioQuery(project, registries, tl, track, clip, range)
    if (!q) return false
    const { mt, media, remap, localRange } = q
    return mt?.hasAudio ? mt.hasAudio({ project, clip, media, range: localRange, remap,
      timelineHasAudio: (id, childRange) => timelineHasAudio(project, registries, id, childRange, path)
    }) : track.kind === 'audio' && media?.meta.hasAudio !== false
  }))
}

/** Timelines whose clips must have PCM prepared, each with the hull of the timeline-local ranges
 * that actually sound: composition descendants are only included when an audible, visible
 * wrapper instance reaches them, and only for the source range that instance plays (through its
 * trim, speed and transitions). Shared descendants are decoded once over the union of their
 * instances, because processed clip PCM is keyed by the source clip's identity. */
export function compositionAudioRanges(project: Project, registries: Registries, timelineId: Id, range: Range):
  { timeline: Timeline; range: Range }[] {
  const found = new Map<Id, Range>(), seen = new Set<string>()
  const visit = (id: Id, range: Range, path: readonly Id[]) => {
    const timeline = project.timelines[id]
    if (!timeline || path.includes(id) || path.length >= MAX_DEPTH || range.end <= range.start) return
    const key = `${path.join('>')}>${id}@${range.start}:${range.end}`
    if (seen.has(key)) return
    seen.add(key)
    const known = found.get(id)
    found.set(id, known ? { start: Math.min(known.start, range.start), end: Math.max(known.end, range.end) } : range)
    const next = [...path, id]
    for (const track of audibleTracks(timeline)) for (const clip of track.clips) {
      const q = clipAudioQuery(project, registries, timeline, track, clip, range)
      if (!q?.mt?.hasAudio) continue
      q.mt.hasAudio({ project, clip, media: q.media, range: q.localRange, remap: q.remap, timelineHasAudio: (child, childRange) => {
        const target = project.timelines[child]
        const clamped = { start: Math.max(0, childRange.start), end: Math.min(timelineDuration(target ?? timeline), childRange.end) }
        if (!target || !timelineHasAudio(project, registries, child, clamped, next)) return false
        visit(child, clamped, next)
        return true
      } })
    }
  }
  visit(timelineId, range, [])
  return [...found].map(([id, range]) => ({ timeline: project.timelines[id], range }))
}
