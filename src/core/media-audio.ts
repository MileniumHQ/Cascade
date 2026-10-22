import type { Registries } from './app'
import { timelineDuration, type Id, type Project, type Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'
import { anySolo, trackAudible } from '@shared/audio-mix'
import { extendMap, clipTimeMap, sourceLocalRange } from './time-remap'
import { transitionClipRange } from './transitions'
import { sourceMeta, timelineDependencies } from './compositions'

/** Plugin-driven audio detection, including visual media that carries its own sound. */
export function timelineHasAudio(project: Project, registries: Registries, timelineId: Id,
  range: { start: Flicks; end: Flicks }, ancestors: readonly Id[] = []): boolean {
  const tl = project.timelines[timelineId]
  if (!tl || ancestors.includes(timelineId) || ancestors.length >= 64 || range.end <= range.start) return false
  const path = [...ancestors, timelineId], solo = anySolo(tl.tracks)
  return tl.tracks.some(track => trackAudible(track, solo) && !(track.kind === 'visual' && track.hidden) && track.clips.some(clip => {
    const mt = registries.mediaTypes.get(clip.type)
    const active = transitionClipRange(track, clip, tx => !!registries.transitions.get(tx.type)?.kinds.includes(track.kind))
    const remap = extendMap(clipTimeMap(clip, tl, registries), clip.duration)
    if (remap.max === 0) return false
    const original = clip.mediaId ? project.media[clip.mediaId] : undefined
    const media = original && { ...original, meta: sourceMeta(original, project, registries) }
    const available = sourceLocalRange(clip, remap, media?.meta.duration)
    const localRange = {
      start: Math.max(range.start, active.start, clip.start + available.start) - clip.start,
      end: Math.min(range.end, active.end, clip.start + available.end) - clip.start
    }
    if (localRange.end <= localRange.start) return false
    return mt?.hasAudio ? mt.hasAudio({ project, clip, media, range: localRange, remap,
      timelineHasAudio: (id, childRange) => timelineHasAudio(project, registries, id, childRange, path)
    }) : track.kind === 'audio' && media?.meta.hasAudio !== false
  }))
}

/** Source-time scopes needed for PCM preparation. Shared descendants are decoded once.
 * Descendants use their full range because a composition may be instantiated repeatedly at
 * different trims/rates, and processed clip PCM is keyed by the source clip's identity. */
export function compositionAudioRanges(project: Project, timelineId: Id, range: { start: Flicks; end: Flicks }):
  { timeline: Timeline; range: { start: Flicks; end: Flicks } }[] {
  const result: ReturnType<typeof compositionAudioRanges> = [], seen = new Set<Id>()
  const visit = (id: Id, range: { start: Flicks; end: Flicks }) => {
    const timeline = project.timelines[id]
    if (!timeline || seen.has(id)) return
    seen.add(id)
    result.push({ timeline, range })
    for (const child of timelineDependencies(project, id)) {
      const tl = project.timelines[child]
      if (tl) visit(child, { start: 0, end: timelineDuration(tl) })
    }
  }
  visit(timelineId, range)
  return result
}
