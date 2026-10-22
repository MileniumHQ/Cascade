/** Generic composition dependencies. No media type ids: references survive missing plugins. */
import type { Id, MediaItem, MediaMeta, Project, Timeline } from '@shared/project'
import type { Registries } from './app'

export function sourceMeta(media: MediaItem, project: Project, registries: Pick<Registries, 'mediaTypes'>): MediaMeta {
  return registries.mediaTypes.get(media.type)?.sourceMeta?.(media, project) ?? media.meta
}

const dependencyCache = new WeakMap<Timeline, { media: Project['media']; refs: ReadonlySet<Id> }>()
export function timelineDependencies(project: Project, id: Id): ReadonlySet<Id> {
  const tl = project.timelines[id]
  if (!tl) return new Set()
  const cached = Object.isFrozen(tl) ? dependencyCache.get(tl) : undefined
  if (cached?.media === project.media) return cached.refs
  const refs = new Set(tl.tracks.flatMap(t => t.clips.flatMap(c => {
    const ref = c.mediaId && project.media[c.mediaId]?.timelineId
    return ref ? [ref] : []
  })))
  if (Object.isFrozen(tl)) dependencyCache.set(tl, { media: project.media, refs })
  return refs
}

export function canReferenceTimeline(project: Project, owner: Id, target: Id): boolean {
  const seen = new Set<Id>()
  const visit = (id: Id): boolean => {
    if (id === owner) return true
    if (seen.has(id)) return false
    seen.add(id)
    return [...timelineDependencies(project, id)].some(visit)
  }
  return !!project.timelines[target] && !visit(target)
}

/** Validate newly introduced edges only: malformed old documents remain editable/removable. */
export function validateCompositionChanges(before: Project, after: Project): void {
  for (const id of Object.keys(before.timelines)) if (!after.timelines[id]) {
    if (Object.keys(after.timelines).some(owner => timelineDependencies(after, owner).has(id)))
      throw new Error('This timeline is used by a composition clip')
  }
  for (const id of Object.keys(after.timelines)) {
    const previous = timelineDependencies(before, id)
    for (const ref of timelineDependencies(after, id)) {
      if (!previous.has(ref) && !canReferenceTimeline(after, id, ref))
        throw new Error('A composition cannot contain itself, directly or indirectly (or reference a missing timeline)')
    }
  }
}
