import type { Flicks, FrameRate } from './time'

/**
 * The Cascade project document. Pure JSON — every mutation goes through the command system
 * (see core/document.ts) so it can be undone, synced to an agent, or replayed.
 *
 * The core knows nothing about specific media types or properties: they are referenced by
 * string ids and implemented by plugins. Unknown ids are preserved (never dropped) so a project
 * opened without a plugin keeps that plugin's data.
 */
export const PROJECT_VERSION = 1

export type Id = string

export interface ProjectSettings {
  /** Reference resolution. Used for UI px display and as the default export size. */
  width: number
  height: number
  fps: FrameRate
  sampleRate: number
  background: string
}

export interface MediaMeta {
  duration?: Flicks
  width?: number
  height?: number
  fps?: FrameRate
  hasVideo?: boolean
  hasAudio?: boolean
  videoCodec?: string
  audioCodec?: string
  size?: number
}

export interface MediaItem {
  id: Id
  /** Media type id (plugin provided), e.g. "video", "image", "audio". */
  type: string
  name: string
  /** Absolute file path for file-backed media. Generators (e.g. text) have none. */
  path?: string
  meta: MediaMeta
  /** Playback proxy (for codecs Chromium can't play natively). */
  proxyPath?: string
  data?: Record<string, unknown>
}

export interface EasingRef {
  id: string
  params?: number[]
}

export interface Keyframe {
  id: Id
  /** Time relative to the clip start. */
  t: Flicks
  value: unknown
  /** Easing for the segment that starts at this keyframe. */
  easing: EasingRef
}

export interface ParamValue {
  value: unknown
  keyframes?: Keyframe[]
}

export interface PropertyInstance {
  id: Id
  /** Property type id (plugin provided), e.g. "transform", "blur". */
  type: string
  enabled: boolean
  params: Record<string, ParamValue>
}

export interface Clip {
  id: Id
  /** Media type id. */
  type: string
  mediaId?: Id
  name: string
  start: Flicks
  duration: Flicks
  /** Offset into the source media where this clip begins (for time-based media). */
  sourceIn: Flicks
  /** Playback speed multiplier for time-based media. */
  speed?: number
  /** Markers use absolute source flicks, in the same coordinates as sourceIn. */
  markers?: Marker[]
  properties: PropertyInstance[]
  /** Media-type specific data (e.g. text content for elements). */
  data: Record<string, unknown>
  /** Clips sharing a linkId move/trim together (e.g. a video and its audio). */
  linkId?: Id
  /** Optional user color override. */
  color?: string
}

export interface TransitionInstance {
  id: Id
  /** Plugin type id. Unknown types and params survive save/load. */
  type: string
  /** Outgoing end edge; absent for a fade in. */
  from?: Id
  /** Incoming start edge; absent for a fade out. */
  to?: Id
  duration: Flicks
  align: 'center' | 'start' | 'end'
  params: Record<string, unknown>
  /** Explicit pairing of linked picture/sound transitions (not inferred from proximity). */
  linkId?: Id
}

export type TrackKind = 'visual' | 'audio'

export interface Track {
  id: Id
  kind: TrackKind
  name: string
  hidden: boolean
  muted: boolean
  locked: boolean
  /** Audio tracks: when any track is soloed, non-soloed audio tracks are silent. */
  solo?: boolean
  /** Audio tracks: fader level in dB (default 0). Not keyframeable. */
  gain?: number
  /** Audio tracks: stereo position -1 (left) … 1 (right), default 0. */
  pan?: number
  /** Clips sorted by start, never overlapping. */
  clips: Clip[]
  height?: number
  transitions?: TransitionInstance[]
}

export interface Marker {
  duration?: Flicks
  note?: string
  kind?: string
  data?: unknown
  id: Id
  t: Flicks
  name: string
  color?: string
}

export interface Timeline {
  id: Id
  name: string
  /** Visual tracks bottom → top, then audio tracks top → bottom (A1 first). */
  tracks: Track[]
  markers: Marker[]
  inPoint?: Flicks
  outPoint?: Flicks
}

export interface Project {
  version: number
  id: Id
  name: string
  settings: ProjectSettings
  media: Record<Id, MediaItem>
  mediaOrder: Id[]
  timelines: Record<Id, Timeline>
  timelineOrder: Id[]
  activeTimeline: Id
  /** Namespaced data for plugins: pluginData[pluginId] = anything JSON. */
  pluginData: Record<string, unknown>
  createdAt: number
  modifiedAt: number
}

let counter = 0
export const uid = (prefix = ''): Id => {
  counter = (counter + 1) % 1_000_000
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createTimeline(name = 'Main Timeline'): Timeline {
  return {
    id: uid('tl_'),
    name,
    tracks: [
      { id: uid('tr_'), kind: 'visual', name: 'V1', hidden: false, muted: false, locked: false, clips: [] },
      { id: uid('tr_'), kind: 'visual', name: 'V2', hidden: false, muted: false, locked: false, clips: [] },
      { id: uid('tr_'), kind: 'visual', name: 'V3', hidden: false, muted: false, locked: false, clips: [] },
      { id: uid('tr_'), kind: 'audio', name: 'A1', hidden: false, muted: false, locked: false, clips: [] },
      { id: uid('tr_'), kind: 'audio', name: 'A2', hidden: false, muted: false, locked: false, clips: [] }
    ],
    markers: []
  }
}

export function createProject(name: string, settings: Partial<ProjectSettings> = {}): Project {
  const tl = createTimeline()
  return {
    version: PROJECT_VERSION,
    id: uid('pr_'),
    name,
    settings: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      sampleRate: 48000,
      background: '#000000',
      ...settings
    },
    media: {},
    mediaOrder: [],
    timelines: { [tl.id]: tl },
    timelineOrder: [tl.id],
    activeTimeline: tl.id,
    pluginData: {},
    createdAt: Date.now(),
    modifiedAt: Date.now()
  }
}

export const clipEnd = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration

/** Duration of a timeline = end of its last clip. */
export function timelineDuration(tl: Timeline): Flicks {
  let end = 0
  for (const tr of tl.tracks) {
    const last = tr.clips[tr.clips.length - 1]
    if (last) end = Math.max(end, clipEnd(last))
  }
  return end
}

export function findClip(tl: Timeline, clipId: Id): { track: Track; clip: Clip; index: number } | null {
  for (const track of tl.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}
