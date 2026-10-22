import { clipEnd, findClip, uid, type Clip, type Id, type MediaItem, type Project, type PropertyInstance, type Timeline, type Track, type TrackKind } from '@shared/project'
import { cloneClip, expandLinked, insertTime, placeClip } from '@core/timeline-ops'
export interface ClipClipboardPayload {
  cascade: 'clips'
  version: 1
  clips: { clip: Clip; kind: TrackKind; trackOffset: number; sourceTrack: Id }[]
  media: MediaItem[]
}
export interface PropertyClipboardPayload { cascade: 'property'; version: 1; property: PropertyInstance }
export interface FormatClipboardPayload { cascade: 1; format: string; data: unknown }
export type ClipboardPayload = ClipClipboardPayload | PropertyClipboardPayload | FormatClipboardPayload
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const kindTracks = (tl: Timeline, kind: TrackKind) => {
  const tracks = tl.tracks.filter((tr) => tr.kind === kind)
  return kind === 'visual' ? tracks.reverse() : tracks
}

/** JSON remains plugin-neutral: unknown clip/property ids and their data survive unchanged. */
export function captureClips(project: Project, ids: Iterable<Id>): ClipClipboardPayload | null {
  const tl = project.timelines[project.activeTimeline]
  const all = expandLinked(tl, ids)
  const found = [...all].map((id) => findClip(tl, id)).filter((f): f is NonNullable<typeof f> => !!f)
  if (!found.length) return null
  const start = Math.min(...found.map((f) => f.clip.start))
  const origins = new Map<TrackKind, number>()
  for (const f of found) origins.set(f.track.kind, Math.min(origins.get(f.track.kind) ?? Infinity, kindTracks(tl, f.track.kind).indexOf(f.track)))
  const clips = found.map(({ clip, track }) => ({ clip: { ...copy(clip), start: clip.start - start }, kind: track.kind, trackOffset: kindTracks(tl, track.kind).indexOf(track) - origins.get(track.kind)!, sourceTrack: track.id }))
  const media = [...new Set(clips.map((e) => e.clip.mediaId))].flatMap((id) => id && project.media[id] ? [copy(project.media[id])] : [])
  return { cascade: 'clips', version: 1, clips, media }
}

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const time = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const markers = (v: unknown) => v === undefined || Array.isArray(v) && v.every(m => record(m) && typeof m.id === 'string' && typeof m.name === 'string' && time(m.t) && (m.duration === undefined || time(m.duration)) && ['color','kind','note'].every(k => m[k] === undefined || typeof m[k] === 'string'))
const property = (v: unknown): v is PropertyInstance => record(v) && typeof v.id === 'string' && typeof v.type === 'string' && typeof v.enabled === 'boolean' && record(v.params) && Object.values(v.params).every((pv) => record(pv) && (!pv.keyframes || Array.isArray(pv.keyframes) && pv.keyframes.every((k: unknown) => record(k) && typeof k.id === 'string' && Number.isSafeInteger(k.t) && record(k.easing) && typeof k.easing.id === 'string')))
export function parseClipboard(text: string): ClipboardPayload | null {
  try {
    const v = JSON.parse(text)
    if (!record(v)) return null
    if (v.cascade === 1) return typeof v.format === 'string' && v.format.length > 0 && Object.hasOwn(v, 'data') ? v as FormatClipboardPayload : null
    if (v.version !== 1) return null
    if (v.cascade === 'property') return property(v.property) ? v as PropertyClipboardPayload : null
    if (v.cascade !== 'clips' || !Array.isArray(v.clips) || !v.clips.length || !Array.isArray(v.media)) return null
    if (!v.clips.every((e: unknown) => record(e) && (e.kind === 'visual' || e.kind === 'audio') && time(e.trackOffset) && e.trackOffset < 1000 && typeof e.sourceTrack === 'string' && record(e.clip) && typeof e.clip.id === 'string' && typeof e.clip.type === 'string' && typeof e.clip.name === 'string' && (e.clip.mediaId === undefined || typeof e.clip.mediaId === 'string') && (e.clip.linkId === undefined || typeof e.clip.linkId === 'string') && (e.clip.speed === undefined || Number.isFinite(e.clip.speed)) && time(e.clip.start) && time(e.clip.duration) && e.clip.duration > 0 && time(e.clip.sourceIn) && record(e.clip.data) && Array.isArray(e.clip.properties) && e.clip.properties.every(property) && markers(e.clip.markers))) return null
    for (const kind of ['visual', 'audio']) if (v.clips.some((e: any) => e.kind === kind) && !v.clips.some((e: any) => e.kind === kind && e.trackOffset === 0)) return null
    if (!v.media.every((m: unknown) => record(m) && typeof m.id === 'string' && typeof m.type === 'string' && typeof m.name === 'string' && record(m.meta) && (m.path === undefined || typeof m.path === 'string'))) return null
    return v as ClipClipboardPayload
  } catch { return null }
}

/** Place a payload into a mutable project. Returns null atomically when a destination is locked. */
export function pasteClips(project: Project, payload: ClipClipboardPayload, at: number, targetTrack?: Id | null, insert = false, rippleMarkers = true): Id[] | null {
  if (!payload.clips.length || !time(at)) return null
  const tl = project.timelines[project.activeTimeline]
  const target = tl.tracks.find((tr) => tr.id === targetTrack)
  const destinations = new Map<TrackKind, Track[]>()
  for (const kind of ['visual', 'audio'] as const) {
    const entries = payload.clips.filter((e) => e.kind === kind)
    if (!entries.length) continue
    const tracks = kindTracks(tl, kind)
    const origin = entries.find((e) => e.trackOffset === 0)
    if (!origin) return null
    const base = target?.kind === kind ? tracks.indexOf(target) : Math.max(0, tracks.findIndex((tr) => tr.id === origin.sourceTrack))
    const max = Math.max(...entries.map((e) => e.trackOffset))
    const needed: Track[] = []
    let created = 0
    for (let i = 0; i <= max; i++) {
      const tr = tracks[base + i] ?? { id: uid('tr_'), kind, name: `${kind === 'visual' ? 'V' : 'A'}${tracks.length + ++created}`, hidden: false, muted: false, locked: false, clips: [] }
      needed.push(tr)
    }
    destinations.set(kind, needed)
  }
  const used = payload.clips.map((e) => destinations.get(e.kind)![e.trackOffset])
  if (used.some((tr) => tr.locked)) return null
  const length = Math.max(...payload.clips.map((e) => clipEnd(e.clip)))
  if (!time(length) || !time(at + length)) return null
  // Run insertion on a trial timeline first, so a locked linked tail cannot leave partial changes.
  if (insert) {
    const trial = copy(tl)
    if (!insertTime(trial, used.map((tr) => tr.id), at, length, rippleMarkers)) return null
    if (!insertTime(tl, used.map((tr) => tr.id), at, length, rippleMarkers)) return null
  }
  for (const tracks of destinations.values()) for (const tr of tracks) if (!tl.tracks.includes(tr)) {
    if (tr.kind === 'visual') tl.tracks.unshift(tr)
    else tl.tracks.push(tr)
  }
  const media = new Map<Id, Id>()
  for (const item of payload.media) {
    const same = item.path ? Object.values(project.media).find((m) => m.path === item.path) : project.media[item.id] && JSON.stringify(project.media[item.id]) === JSON.stringify(item) ? project.media[item.id] : undefined
    if (same) media.set(item.id, same.id)
    else {
      const m = copy(item)
      m.id = uid('md_')
      media.set(item.id, m.id)
      project.media[m.id] = m
      project.mediaOrder.push(m.id)
    }
  }
  const links = new Map<Id, Id>()
  return payload.clips.map((entry, i) => {
    const c = cloneClip(entry.clip)
    c.start += at
    if (c.mediaId && media.has(c.mediaId)) c.mediaId = media.get(c.mediaId)
    if (c.linkId) {
      if (!links.has(c.linkId)) links.set(c.linkId, uid('ln_'))
      c.linkId = links.get(c.linkId)
    }
    placeClip(used[i], c)
    return c.id
  })
}

