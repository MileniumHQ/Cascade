import { copiedTransitions, remapTransitions } from '@core/transition-copy'
import { clipEnd, findClip, uid, type Clip, type Id, type MediaItem, type Project, type PropertyInstance, type Timeline, type Track, type TrackKind, type TransitionInstance } from '@shared/project'
import { cloneClip, expandLinked, insertTime, placeClip } from '@core/timeline-ops'
export interface ClipClipboardPayload {
  cascade: 'clips'
  version: 1
  clips: { clip: Clip; kind: TrackKind; trackOffset: number; sourceTrack: Id }[]
  media: MediaItem[]
  projectId?: Id
  timelines?: Timeline[]
  transitions?: { sourceTrack: Id; transition: TransitionInstance }[]
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
  const media: MediaItem[] = [], timelines: Timeline[] = [], seenMedia = new Set<Id>(), seenTimelines = new Set<Id>()
  const visitMedia = (id?: Id) => {
    if (!id || seenMedia.has(id) || !project.media[id]) return
    seenMedia.add(id)
    const item = project.media[id]
    media.push(copy(item))
    const tl = item.timelineId && project.timelines[item.timelineId]
    if (!tl || seenTimelines.has(tl.id)) return
    seenTimelines.add(tl.id); timelines.push(copy(tl))
    for (const track of tl.tracks) for (const clip of track.clips) visitMedia(clip.mediaId)
  }
  for (const entry of clips) visitMedia(entry.clip.mediaId)
  const transitions = tl.tracks.flatMap(track => copiedTransitions(track, all).map(transition => ({ sourceTrack: track.id, transition: copy(transition) })))
  return { cascade: 'clips', version: 1, clips, media, projectId: project.id, timelines, transitions }
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
    const transition = (t: unknown) => record(t) && typeof t.id === 'string' && typeof t.type === 'string' && (typeof t.from === 'string' || typeof t.to === 'string') && ['from','to','linkId'].every(k => t[k] === undefined || typeof t[k] === 'string') && time(t.duration) && t.duration > 0 && ['center','start','end'].includes(t.align) && record(t.params)
    if (v.transitions !== undefined && (!Array.isArray(v.transitions) || !v.transitions.every((e: unknown) => record(e) && typeof e.sourceTrack === 'string' && transition(e.transition) && v.clips.some((c: any) => c.sourceTrack === e.sourceTrack && (c.clip.id === e.transition.from || c.clip.id === e.transition.to)) && [e.transition.from,e.transition.to].every(id => !id || v.clips.some((c: any) => c.sourceTrack === e.sourceTrack && c.clip.id === id))))) return null
    if (v.projectId !== undefined && typeof v.projectId !== 'string') return null
    if (v.timelines !== undefined && (!Array.isArray(v.timelines) || !v.timelines.every((tl: unknown) => record(tl) && typeof tl.id === 'string' && typeof tl.name === 'string' && markers(tl.markers) && Array.isArray(tl.tracks) && tl.tracks.every((tr: unknown) => record(tr) && typeof tr.id === 'string' && typeof tr.name === 'string' && ['visual','audio'].includes(tr.kind) && ['hidden','muted','locked'].every(k => typeof tr[k] === 'boolean') && Array.isArray(tr.clips) && (tr.transitions === undefined || Array.isArray(tr.transitions) && tr.transitions.every(transition)) && (!tr.clips.length || parseClipboard(JSON.stringify({ cascade: 'clips', version: 1, clips: tr.clips.map((clip: unknown) => ({clip, kind: tr.kind, trackOffset: 0, sourceTrack: tr.id})), media: [] })) !== null))))) return null
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
  const timelineIds = new Map<Id, Id>()
  for (const timeline of payload.timelines ?? []) timelineIds.set(timeline.id, payload.projectId === project.id && project.timelines[timeline.id] ? timeline.id : uid('tl_'))
  const media = new Map<Id, Id>()
  for (const item of payload.media) {
    const same = item.timelineId ? payload.projectId === project.id && timelineIds.get(item.timelineId) === item.timelineId && project.media[item.id]?.timelineId === item.timelineId ? project.media[item.id] : undefined : item.path ? Object.values(project.media).find((m) => m.path === item.path) : project.media[item.id] && JSON.stringify(project.media[item.id]) === JSON.stringify(item) ? project.media[item.id] : undefined
    if (same) media.set(item.id, same.id)
    else {
      const m = copy(item)
      m.id = uid('md_')
      if (m.timelineId && timelineIds.has(m.timelineId)) m.timelineId = timelineIds.get(m.timelineId)
      media.set(item.id, m.id)
      project.media[m.id] = m
      project.mediaOrder.push(m.id)
    }
  }
  const links = new Map<Id, Id>()
  for (const source of payload.timelines ?? []) {
    const id = timelineIds.get(source.id)!
    if (id === source.id) continue
    const nested = copy(source), clipIds = new Map<Id, Id>()
    nested.id = id
    for (const m of nested.markers) m.id = uid('mk_')
    for (const track of nested.tracks) {
      track.id = uid('tr_')
      track.clips = track.clips.map(clip => {
        const c = cloneClip(clip); clipIds.set(clip.id, c.id)
        if (c.mediaId) c.mediaId = media.get(c.mediaId) ?? c.mediaId
        if (c.linkId) { if (!links.has(c.linkId)) links.set(c.linkId, uid('ln_')); c.linkId = links.get(c.linkId) }
        return c
      })
    }
    for (const track of nested.tracks) track.transitions = remapTransitions(track.transitions ?? [], clipIds, links)
    project.timelines[id] = nested; project.timelineOrder.push(id)
  }
  const clipIds = new Map<Id, Id>()
  const ids = payload.clips.map((entry, i) => {
    const c = cloneClip(entry.clip)
    clipIds.set(entry.clip.id, c.id)
    c.start += at
    if (c.mediaId && media.has(c.mediaId)) c.mediaId = media.get(c.mediaId)
    if (c.linkId) {
      if (!links.has(c.linkId)) links.set(c.linkId, uid('ln_'))
      c.linkId = links.get(c.linkId)
    }
    placeClip(used[i], c)
    return c.id
  })
  for (const entry of payload.transitions ?? []) {
    const i = payload.clips.findIndex(e => e.sourceTrack === entry.sourceTrack)
    if (i < 0) continue
    const track = used[i]
    ;(track.transitions ??= []).push(...remapTransitions([entry.transition], clipIds, links))
  }
  return ids
}

