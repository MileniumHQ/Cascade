import { findClip, type Clip, type Id, type Timeline, type Track } from '@shared/project'

export const MIN_VOLUME_DB = -60
export const MAX_VOLUME_DB = 24

/** Volume (dB) that plays a source of integrated loudness `level` LUFS at `target`, rounded to 0.1 dB. */
export const normalizedVolume = (level: number, target: number) => Math.round(Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, target - level)) * 10) / 10

/**
 * Audio clips to process for a set of clip ids. A picture clip stands for its linked audio
 * partner; clips on audio tracks stand for themselves. Duplicates are dropped, order is kept.
 */
export function audioTargets(tl: Timeline, ids: readonly Id[], isAudioTrack: (t: Track) => boolean = (t) => t.kind === 'audio'): { clip: Clip; track: Track }[] {
  const out = new Map<Id, { clip: Clip; track: Track }>()
  for (const id of ids) {
    const found = findClip(tl, id)
    if (!found) continue
    if (isAudioTrack(found.track)) {
      out.set(found.clip.id, { clip: found.clip, track: found.track })
      continue
    }
    if (!found.clip.linkId) continue
    for (const track of tl.tracks) {
      if (!isAudioTrack(track)) continue
      for (const clip of track.clips) if (clip.linkId === found.clip.linkId && clip.id !== found.clip.id) out.set(clip.id, { clip, track })
    }
  }
  return [...out.values()]
}
