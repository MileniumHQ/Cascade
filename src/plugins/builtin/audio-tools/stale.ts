import { findClip, type Clip, type Id, type Project, type Track } from '@shared/project'

/** What a long-running tool saw when it chose its targets; revalidated before committing. */
export interface TargetSnapshot {
  projectId: Id
  timelineId: Id
  clip: Clip
  track: Track
  /** Source range the clip plays (flicks), so a changed speed/trim invalidates a measurement. */
  span: { lo: number; hi: number }
}

type Span = (clip: Clip) => { lo: number; hi: number }

export const snapshotTargets = (project: Project, targets: readonly { clip: Clip; track: Track }[], span: Span): TargetSnapshot[] =>
  targets.map(({ clip, track }) => ({ projectId: project.id, timelineId: project.activeTimeline, clip, track, span: span(clip) }))

/**
 * The live clip/track for a snapshot, or the reason it can no longer be edited: another project
 * or timeline is open, the clip is gone, moved to another track, locked, or its source range,
 * position or properties changed since the snapshot.
 */
export function revalidate(project: Project, snapshot: TargetSnapshot, span: Span): { clip: Clip; track: Track } | string {
  if (project.id !== snapshot.projectId || project.activeTimeline !== snapshot.timelineId) return 'the project or timeline changed'
  const timeline = project.timelines[snapshot.timelineId]
  const found = timeline && findClip(timeline, snapshot.clip.id)
  if (!found) return 'the clip was removed'
  const { clip, track } = found
  if (track.id !== snapshot.track.id) return 'the clip moved to another track'
  if (track.locked) return 'track locked'
  const before = snapshot.clip
  if (clip.mediaId !== before.mediaId || clip.start !== before.start || clip.duration !== before.duration || clip.sourceIn !== before.sourceIn) return 'the clip was edited'
  if (clip.properties !== before.properties && JSON.stringify(clip.properties) !== JSON.stringify(before.properties)) return 'the clip was edited'
  const now = span(clip)
  if (now.lo !== snapshot.span.lo || now.hi !== snapshot.span.hi) return 'its speed or source range changed'
  return { clip, track }
}
