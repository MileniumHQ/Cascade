/**
 * High-level, undoable editing operations. The UI, keyboard commands, the MCP server and
 * plugins all edit through here so behaviour is identical everywhere.
 */
import { current, type Draft } from 'immer'
import {
  clipEnd,
  findClip,
  uid,
  type Clip,
  type EasingRef,
  type Id,
  type MediaItem,
  type ParamValue,
  type Project,
  type PropertyInstance,
  type Timeline,
  type Track,
  type TrackKind
} from '@shared/project'
import { FLICKS, secondsToFlicks, snapToFrame, type Flicks } from '@shared/time'
import type { CascadeApp } from './app'
import { defaultParams, evaluateParam, keyframeAt, KF_EPSILON } from './evaluate'
import type { ImportCandidate, MediaTypeContribution, ParamDef, PropertyContribution } from './plugin-api'
import * as ops from './timeline-ops'
import { clipTimeMap, constantMap, type TimeMap } from './time-remap'

type DProject = Draft<Project>

export interface GestureOpts {
  gesture?: 'start' | 'update' | 'end'
}

export class Editing {
  constructor(private app: CascadeApp) {}

  /** Trims and splits need the real (possibly keyframed) speed of a clip, linked partners included. */
  private readonly maps = (clip: Clip) => clipTimeMap(clip, this.app.timeline(), this.app.registries)

  /** The document, with every edit transaction resolving time maps for this app's timeline. */
  private readonly doc = {
    transact: (...args: Parameters<CascadeApp['doc']['transact']>) => ops.withTimeMaps(this.maps, () => this.app.doc.transact(...args))
  }

  private tl(d: DProject): Draft<Timeline> {
    return d.timelines[d.activeTimeline]
  }

  private findDraftClip(d: DProject, clipId: Id) {
    return findClip(this.tl(d) as Timeline, clipId) as { track: Draft<Track>; clip: Draft<Clip>; index: number } | null
  }

  private gesture(key: string, opts?: GestureOpts) {
    if (opts?.gesture === 'start') this.app.doc.beginGesture(key)
    return { coalesce: key }
  }
  private endGesture(opts?: GestureOpts) {
    if (opts?.gesture === 'end') this.app.doc.endGesture()
  }

  // ───────────────────────── media ─────────────────────────

  /** Pick the best media type for a file (built-ins first, then priority). */
  mediaTypeFor(file: ImportCandidate): MediaTypeContribution | undefined {
    let best: { score: number; mt: MediaTypeContribution } | undefined
    for (const mt of this.app.registries.mediaTypes.all()) {
      let score = mt.accepts ? mt.accepts(file) : mt.extensions?.includes(file.ext) ? 0.5 : 0
      if (score > 0 && (!best || score > best.score)) best = { score, mt }
    }
    return best?.mt
  }

  async importFiles(paths: string[]): Promise<Id[]> {
    const host = this.app.host
    const added: MediaItem[] = []
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path
      const ext = (name.includes('.') ? name.split('.').pop() : '')!.toLowerCase()
      const meta = host ? await host.media.probe(path) : {}
      if ('error' in meta && meta.error) {
        this.app.notify('error', `Couldn't import ${name}`, String(meta.error))
        continue
      }
      const cand: ImportCandidate = { path, name, ext, meta }
      const mt = this.mediaTypeFor(cand)
      if (!mt) {
        this.app.notify('warning', `No media type can open .${ext} files`, name)
        continue
      }
      const { error: _e, ...cleanMeta } = meta as Record<string, unknown>
      added.push({ id: uid('md_'), type: mt.id, name, path, meta: cleanMeta })
    }
    if (!added.length) return []
    this.doc.transact(`Import ${added.length} item${added.length > 1 ? 's' : ''}`, (d) => {
      for (const m of added) {
        d.media[m.id] = m
        d.mediaOrder.push(m.id)
      }
    })
    return added.map((m) => m.id)
  }

  addGenerated(generatorId: string): Id | null {
    const gen = this.app.registries.generators.get(generatorId)
    if (!gen) return null
    const res = gen.create(this.app.project())
    const m: MediaItem = { id: uid('md_'), type: gen.mediaType, name: res.name, meta: {}, data: { ...res.data, clipData: res.clipData, properties: res.properties, generator: gen.id } }
    this.doc.transact(`Add ${gen.name}`, (d) => {
      d.media[m.id] = m
      d.mediaOrder.push(m.id)
    })
    return m.id
  }

  removeMedia(ids: Id[]) {
    const set = new Set(ids)
    this.doc.transact('Remove media', (d) => {
      for (const id of ids) delete d.media[id]
      d.mediaOrder = d.mediaOrder.filter((id) => !set.has(id))
      for (const tl of Object.values(d.timelines))
        for (const tr of tl.tracks) tr.clips = tr.clips.filter((c) => !c.mediaId || !set.has(c.mediaId))
    })
  }

  /** Point a media item at a different file (undoable). Resolves true when it was relinked. */
  async relinkMedia(mediaId: Id, newPath: string): Promise<boolean> {
    return (await this.relinkMediaMany([{ mediaId, path: newPath }])).length === 1
  }

  /** Relink several items as one undo step. Re-probes each file and warns when its duration differs. Returns the relinked ids. */
  async relinkMediaMany(pairs: { mediaId: Id; path: string }[]): Promise<Id[]> {
    const host = this.app.host
    const done: { id: Id; path: string; meta: MediaItem['meta'] }[] = []
    for (const { mediaId, path } of pairs) {
      const item = this.app.project().media[mediaId]
      if (!item) continue
      const probed = host ? await host.media.probe(path) : {}
      const { error, ...meta } = probed as Record<string, unknown>
      if (error) {
        this.app.notify('error', `Couldn't relink ${item.name}`, String(error))
        continue
      }
      const was = item.meta.duration
      const now = (meta as MediaItem['meta']).duration
      if (was !== undefined && now !== undefined && Math.abs(was - now) > FLICKS / 10) {
        this.app.notify('warning', `${item.name} has a different length`, `${(was / FLICKS).toFixed(1)}s before, ${(now / FLICKS).toFixed(1)}s now. Clips may need adjusting.`)
      }
      done.push({ id: mediaId, path, meta: meta as MediaItem['meta'] })
    }
    if (!done.length) return []
    this.doc.transact(done.length > 1 ? `Relink ${done.length} media` : 'Relink media', (d) => {
      for (const r of done) {
        const m = d.media[r.id]
        if (!m) continue
        m.path = r.path
        m.meta = r.meta
        delete m.proxyPath // it belonged to the old file
      }
    })
    return done.map((r) => r.id)
  }

  renameMedia(id: Id, name: string) {
    this.doc.transact('Rename media', (d) => {
      if (d.media[id]) d.media[id].name = name
    })
  }

  // ───────────────────────── clips ─────────────────────────

  private newPropertyInstance(type: string, values?: Record<string, unknown>): PropertyInstance | null {
    const contrib = this.app.registries.properties.get(type)
    if (!contrib) return null
    const params = defaultParams(contrib)
    for (const [k, v] of Object.entries(values ?? {})) params[k] = { value: v }
    return { id: uid('pi_'), type, enabled: true, params }
  }

  /** Build (but don't insert) a clip for a media item. */
  buildClip(media: MediaItem, start: Flicks, typeOverride?: string): Clip | null {
    const mt = this.app.registries.mediaTypes.get(typeOverride ?? media.type)
    if (!mt) return null
    const dur =
      mt.timeBased && media.meta.duration ? media.meta.duration : secondsToFlicks(mt.defaultDuration ?? 5)
    const presets = (media.data?.properties as { type: string; values?: Record<string, unknown> }[] | undefined) ?? []
    const props = [
      ...(mt.defaultProperties ?? []).filter((t) => !presets.some((p) => p.type === t)).map((t) => this.newPropertyInstance(t)),
      ...presets.map((p) => this.newPropertyInstance(p.type, p.values))
    ].filter(Boolean) as PropertyInstance[]
    const genData = (media.data?.clipData as Record<string, unknown>) ?? {}
    return {
      id: uid('cl_'),
      type: mt.id,
      mediaId: media.id,
      name: media.name,
      start: snapToFrame(start, this.app.fps()),
      duration: snapToFrame(dur, this.app.fps()) || dur,
      sourceIn: 0,
      properties: props,
      data: { ...(mt.defaultData?.(media) ?? {}), ...genData }
    }
  }

  private pickTrack(tl: Draft<Timeline>, kind: TrackKind, preferred?: Id, start?: Flicks, end?: Flicks): Draft<Track> {
    if (preferred) {
      const t = tl.tracks.find((x) => x.id === preferred && x.kind === kind)
      if (t) return t
    }
    const tracks = tl.tracks.filter((t) => t.kind === kind && !t.locked)
    // first track that's free in range
    if (start !== undefined && end !== undefined) {
      const free = tracks.find((t) => ops.clipsInRange(t as Track, start, end).length === 0)
      if (free) return free
    }
    if (tracks[0]) return tracks[0]
    const t: Track = { id: uid('tr_'), kind, name: kind === 'visual' ? 'V1' : 'A1', hidden: false, muted: false, locked: false, clips: [] }
    tl.tracks.push(t)
    return tl.tracks[tl.tracks.length - 1]
  }

  /** Add a media item to the timeline (overwrite). Creates a linked audio clip for video with audio. */
  addMediaToTimeline(mediaId: Id, opts: { start?: Flicks; trackId?: Id; audioTrackId?: Id } = {}): Id[] {
    const media = this.app.project().media[mediaId]
    if (!media) return []
    const mt = this.app.registries.mediaTypes.get(media.type)
    if (!mt) return []
    const start = opts.start ?? this.app.playback.time.get()
    const clip = this.buildClip(media, start)
    if (!clip) return []
    const clips: { clip: Clip; kind: TrackKind; trackId?: Id }[] = [{ clip, kind: mt.track, trackId: opts.trackId }]
    if (mt.linkedAudioType && media.meta.hasAudio) {
      const a = this.buildClip(media, start, mt.linkedAudioType)
      if (a) {
        const link = uid('ln_')
        clip.linkId = link
        a.linkId = link
        a.duration = clip.duration
        clips.push({ clip: a, kind: 'audio', trackId: opts.audioTrackId })
      }
    }
    this.doc.transact(`Add ${media.name}`, (d) => {
      const tl = this.tl(d)
      for (const c of clips) {
        const track = this.pickTrack(tl, c.kind, c.trackId, c.clip.start, c.clip.start + c.clip.duration)
        ops.placeClip(track as Track, c.clip)
      }
    })
    this.app.selection.setClips([...clips.map((c) => c.clip.id).filter((id) => id !== clip.id), clip.id])
    return clips.map((c) => c.clip.id)
  }

  /** Place clips on an existing track in one undo step, overwriting what they cover; `replace` first empties that range of the track. */
  placeClips(trackId: Id, clips: Clip[], opts: { label?: string; replace?: [Flicks, Flicks] } = {}) {
    this.doc.transact(opts.label ?? 'Place clips', (d) => {
      const track = this.tl(d).tracks.find((t) => t.id === trackId)
      if (!track) return
      if (opts.replace) ops.clearRange(track as Track, opts.replace[0], opts.replace[1], new Set())
      for (const c of clips) ops.placeClip(track as Track, structuredClone(c))
    })
  }

  /** Insert an arbitrary clip object (used by MCP / plugins). */
  insertClip(clip: Partial<Clip> & { type: string }, trackId?: Id): Id | null {
    const mt = this.app.registries.mediaTypes.get(clip.type)
    if (!mt) return null
    const full: Clip = {
      id: uid('cl_'),
      name: clip.name ?? mt.name,
      start: clip.start ?? this.app.playback.time.get(),
      duration: clip.duration ?? secondsToFlicks(mt.defaultDuration ?? 5),
      sourceIn: clip.sourceIn ?? 0,
      properties:
        clip.properties ??
        ((mt.defaultProperties ?? []).map((t) => this.newPropertyInstance(t)).filter(Boolean) as PropertyInstance[]),
      data: { ...(mt.defaultData?.() ?? {}), ...(clip.data ?? {}) },
      type: clip.type,
      mediaId: clip.mediaId,
      speed: clip.speed
    }
    this.doc.transact(`Add ${full.name}`, (d) => {
      const tl = this.tl(d)
      ops.placeClip(this.pickTrack(tl, mt.track, trackId, full.start, clipEnd(full)) as Track, full)
    })
    return full.id
  }

  moveClips(moves: ops.MoveRequest[]) {
    if (!moves.length) return
    this.doc.transact(moves.length > 1 ? `Move ${moves.length} clips` : 'Move clip', (d) => {
      ops.moveClips(this.tl(d) as Timeline, moves)
    })
  }

  trimClip(clipId: Id, edge: 'start' | 'end', t: Flicks, opts?: GestureOpts & { linked?: boolean }) {
    const key = `trim:${clipId}:${edge}`
    this.doc.transact(
      'Trim clip',
      (d) => {
        const tl = this.tl(d)
        const ids = opts?.linked === false ? new Set([clipId]) : ops.expandLinked(tl as Timeline, [clipId])
        for (const id of ids) {
          const f = this.findDraftClip(d, id)
          if (!f) continue
          const media = f.clip.mediaId ? d.media[f.clip.mediaId] : undefined
          const mt = this.app.registries.mediaTypes.get(f.clip.type)
          const limits = mt?.timeBased && media?.meta.duration ? { sourceDuration: media.meta.duration } : {}
          ops.trimClip(f.track as Track, id, edge, t, limits)
        }
      },
      this.gesture(key, opts)
    )
    this.endGesture(opts)
  }

  /** Split at time t: selected clips if any intersect, otherwise all unlocked clips under t. */
  splitAt(t: Flicks, clipIds?: Id[]) {
    const tl0 = this.app.timeline()
    let targets = clipIds ?? this.app.selection.clips.get()
    const underT = (id: Id) => {
      const f = findClip(tl0, id)
      return f && f.clip.start < t && clipEnd(f.clip) > t
    }
    targets = targets.filter(underT)
    if (!targets.length) targets = tl0.tracks.filter((tr) => !tr.locked).flatMap((tr) => ops.clipsInRange(tr, t, t + 1).map((c) => c.id))
    const all = [...ops.expandLinked(tl0, targets)]
    if (!all.length) return
    const newIds: Id[] = []
    this.doc.transact('Split', (d) => {
      const linkMap = new Map<string, string>()
      for (const id of all) {
        const f = this.findDraftClip(d, id)
        if (!f) continue
        const right = ops.splitClip(f.track as Track, id, t)
        if (right) {
          newIds.push(right.id)
          if (f.clip.linkId) {
            if (!linkMap.has(f.clip.linkId)) linkMap.set(f.clip.linkId, uid('ln_'))
            right.linkId = linkMap.get(f.clip.linkId)
          }
        }
      }
    })
    return newIds
  }

  deleteClips(ids: Id[], ripple = false) {
    if (!ids.length) return
    const tl0 = this.app.timeline()
    const all = ops.expandLinked(tl0, ids)
    this.doc.transact(ripple ? 'Ripple delete' : 'Delete', (d) => ops.deleteClips(this.tl(d) as Timeline, all, ripple))
  }

  duplicateClips(ids: Id[]) {
    const tl0 = this.app.timeline()
    const all = [...ops.expandLinked(tl0, ids)]
    const newIds: Id[] = []
    this.doc.transact('Duplicate', (d) => {
      const tl = this.tl(d)
      const links = new Map<string, string>()
      let maxEnd = 0
      for (const id of all) {
        const f = findClip(tl0, id)
        if (f) maxEnd = Math.max(maxEnd, clipEnd(f.clip))
      }
      let minStart = Infinity
      for (const id of all) minStart = Math.min(minStart, findClip(tl0, id)?.clip.start ?? Infinity)
      for (const id of all) {
        const f = findClip(tl0, id)
        if (!f) continue
        const c = JSON.parse(JSON.stringify(f.clip)) as Clip
        c.id = uid('cl_')
        for (const p of c.properties) p.id = uid('pi_')
        if (c.linkId) {
          if (!links.has(c.linkId)) links.set(c.linkId, uid('ln_'))
          c.linkId = links.get(c.linkId)
        }
        c.start = maxEnd + (f.clip.start - minStart)
        const track = tl.tracks.find((t) => t.id === f.track.id)!
        ops.placeClip(track as Track, c)
        newIds.push(c.id)
      }
    })
    this.app.selection.setClips(newIds)
  }

  updateClip(clipId: Id, patch: Partial<Pick<Clip, 'name' | 'color' | 'speed'>>, opts?: GestureOpts) {
    const at = this.localTime(clipId)
    this.doc.transact(
      'Edit clip',
      (d) => {
        const f = this.findDraftClip(d, clipId)
        if (!f) return
        const { speed, ...rest } = patch
        Object.assign(f.clip, rest)
        if (speed !== undefined) this.writeSpeed(d, clipId, speed, at)
      },
      this.gesture(`clip:${clipId}`, opts)
    )
    this.endGesture(opts)
  }

  /** The time-remap property type (the built-in Speed), if one is registered. */
  private remapType(): string | undefined {
    return this.app.registries.properties.entries().find((e) => e.value.timeRemap)?.value.id
  }

  /**
   * Speed is the time-remap property of the link group's owner (the clip that has one, else the
   * picture), so video and its audio stay in sync. Keyframed speed gets a keyframe at `at`.
   * A legacy `clip.speed` multiplier is folded into the property.
   */
  private writeSpeed(d: DProject, clipId: Id, speed: number, at: Flicks) {
    const type = this.remapType()
    const tl = this.tl(d) as Timeline
    const group = [...ops.expandLinked(tl, [clipId])].map((id) => this.findDraftClip(d, id)?.clip).filter((c): c is Clip => !!c)
    const self = group.find((c) => c.id === clipId)
    if (!self) return
    const param = type && this.app.registries.properties.get(type)!.timeRemap!
    const has = (c: Clip) => !!type && c.properties.some((p) => p.type === type && p.enabled)
    const visual = (c: Clip) => this.app.registries.mediaTypes.get(c.type)?.track === 'visual'
    let owner = has(self) ? self : (group.find(has) ?? group.find(visual) ?? self)
    if (type && param && !has(owner)) {
      const contrib = this.app.registries.properties.get(type)!
      if (!this.propertyApplies(contrib, owner)) owner = self
      if (this.propertyApplies(contrib, owner)) {
        const inst = this.newPropertyInstance(type)
        if (inst) owner.properties.push(inst)
      }
    }
    const prop = type ? owner.properties.find((p) => p.type === type && p.enabled) : undefined
    if (!prop || !param) {
      // No Speed property available: fall back to the plain multiplier on the whole group.
      for (const c of group) c.speed = speed
      return
    }
    const base = owner.speed ?? 1
    for (const c of group) delete c.speed
    const pv = (prop.params[param] ??= { value: 1 })
    if (pv.keyframes?.length) {
      if (base !== 1) for (const k of pv.keyframes) k.value = Number(k.value) * base
      const t = at + (self.start - owner.start)
      const k = keyframeAt(pv as ParamValue, t)
      if (k) k.value = speed
      else {
        pv.keyframes.push({ id: uid('kf_'), t, value: speed, easing: { id: this.defaultEasing() } })
        pv.keyframes.sort((a, b) => a.t - b.t)
      }
    } else pv.value = speed
  }

  setClipData(clipId: Id, patch: Record<string, unknown>, opts?: GestureOpts) {
    this.doc.transact(
      'Edit clip',
      (d) => {
        const f = this.findDraftClip(d, clipId)
        if (f) Object.assign(f.clip.data, patch)
      },
      this.gesture(`clipdata:${clipId}`, opts)
    )
    this.endGesture(opts)
  }

  unlink(ids: Id[]) {
    this.doc.transact('Unlink', (d) => {
      for (const id of ids) {
        const f = this.findDraftClip(d, id)
        if (!f?.clip.linkId) continue
        const link = f.clip.linkId
        const group = this.tl(d).tracks.flatMap((tr) => tr.clips.filter((c) => c.linkId === link))
        // Partners that followed the group's speed keep it once unlinked.
        const type = this.remapType()
        const owner = type && group.find((c) => c.properties.some((p) => p.type === type && p.enabled))
        for (const c of group) {
          c.linkId = undefined
          if (!owner || c === owner || c.properties.some((p) => p.type === type)) continue
          const prop = owner.properties.find((p) => p.type === type && p.enabled)!
          const shift = owner.start - c.start
          const copy = structuredClone(current(prop))
          copy.id = uid('pi_')
          for (const pv of Object.values(copy.params)) for (const k of pv.keyframes ?? []) (k.t += shift), (k.id = uid('kf_'))
          c.properties.push(copy)
        }
      }
    })
  }

  link(ids: Id[]) {
    if (ids.length < 2) return
    const link = uid('ln_')
    this.doc.transact('Link', (d) => {
      for (const id of ids) {
        const f = this.findDraftClip(d, id)
        if (f) f.clip.linkId = link
      }
    })
  }

  // ───────────────────────── tracks ─────────────────────────

  addTrack(kind: TrackKind, opts: { name?: string; clips?: Clip[]; label?: string } = {}): Id {
    const id = uid('tr_')
    this.doc.transact(opts.label ?? 'Add track', (d) => {
      const tl = this.tl(d)
      const n = tl.tracks.filter((t) => t.kind === kind).length + 1
      const track: Track = { id, kind, name: opts.name ?? `${kind === 'visual' ? 'V' : 'A'}${n}`, hidden: false, muted: false, locked: false, clips: structuredClone(opts.clips ?? []) }
      if (kind === 'visual') {
        const lastVisual = tl.tracks.map((t) => t.kind).lastIndexOf('visual')
        tl.tracks.splice(lastVisual + 1, 0, track)
      } else tl.tracks.push(track)
    })
    return id
  }

  removeTrack(trackId: Id) {
    this.doc.transact('Remove track', (d) => {
      const tl = this.tl(d)
      tl.tracks = tl.tracks.filter((t) => t.id !== trackId)
    })
  }

  /** Mixer fields (`solo`, `gain`, `pan`) coalesce per field while a fader/knob is dragged; pass `gesture` for exact undo steps. */
  updateTrack(trackId: Id, patch: Partial<Pick<Track, 'name' | 'hidden' | 'muted' | 'locked' | 'height' | 'solo' | 'gain' | 'pan'>>, opts?: GestureOpts) {
    const key = 'gain' in patch ? `track:${trackId}:gain` : 'pan' in patch ? `track:${trackId}:pan` : `track:${trackId}`
    this.doc.transact('Edit track', (d) => {
      const t = this.tl(d).tracks.find((x) => x.id === trackId)
      if (!t) return
      Object.assign(t, patch)
      // Defaults are not stored, so a reset fader leaves the document as it was.
      if (!t.gain) delete t.gain
      if (!t.pan) delete t.pan
      if (!t.solo) delete t.solo
    }, this.gesture(key, opts))
    this.endGesture(opts)
  }

  // ───────────────────────── properties ─────────────────────────

  propertyApplies(contrib: PropertyContribution, clip: Clip): boolean {
    const media = clip.mediaId ? this.app.project().media[clip.mediaId] : undefined
    const mt = this.app.registries.mediaTypes.get(clip.type)
    if (contrib.shader && !mt?.pixels) return false
    const at = contrib.appliesTo
    if (typeof at === 'function') return at(clip, media)
    if (Array.isArray(at)) return at.includes(clip.type)
    // default: visual properties apply to visual clips, audio ones to audio clips
    const isAudioProp = !!contrib.audio && !contrib.apply && !contrib.shader
    return isAudioProp ? mt?.track === 'audio' : mt?.track !== 'audio'
  }

  addProperty(clipId: Id, type: string): Id | null {
    const inst = this.newPropertyInstance(type)
    if (!inst) return null
    const contrib = this.app.registries.properties.get(type)!
    this.doc.transact(`Add ${contrib.name}`, (d) => {
      const f = this.findDraftClip(d, clipId)
      if (!f) return
      if (!contrib.stackable && f.clip.properties.some((p) => p.type === type)) return
      f.clip.properties.push(inst)
    })
    return inst.id
  }

  removeProperty(clipId: Id, propertyId: Id) {
    this.doc.transact('Remove property', (d) => {
      const f = this.findDraftClip(d, clipId)
      if (f) f.clip.properties = f.clip.properties.filter((p) => p.id !== propertyId)
    })
  }

  moveProperty(clipId: Id, propertyId: Id, toIndex: number) {
    this.doc.transact('Reorder property', (d) => {
      const f = this.findDraftClip(d, clipId)
      if (!f) return
      const i = f.clip.properties.findIndex((p) => p.id === propertyId)
      if (i < 0) return
      const [p] = f.clip.properties.splice(i, 1)
      f.clip.properties.splice(Math.max(0, Math.min(toIndex, f.clip.properties.length)), 0, p)
    })
  }

  setPropertyEnabled(clipId: Id, propertyId: Id, enabled: boolean) {
    this.doc.transact(enabled ? 'Enable property' : 'Disable property', (d) => {
      const p = this.findDraftClip(d, clipId)?.clip.properties.find((x) => x.id === propertyId)
      if (p) p.enabled = enabled
    })
  }

  resetProperty(clipId: Id, propertyId: Id) {
    this.doc.transact('Reset property', (d) => {
      const p = this.findDraftClip(d, clipId)?.clip.properties.find((x) => x.id === propertyId)
      const contrib = p && this.app.registries.properties.get(p.type)
      if (p && contrib) p.params = defaultParams(contrib) as typeof p.params
    })
  }

  // ───────────────────────── params & keyframes ─────────────────────────

  paramDef(type: string, paramId: string): ParamDef | undefined {
    return this.app.registries.properties.get(type)?.params.find((p) => p.id === paramId)
  }

  /** Clip-local time of the playhead for a clip. */
  localTime(clipId: Id): Flicks {
    const f = findClip(this.app.timeline(), clipId)
    if (!f) return 0
    return Math.min(f.clip.duration, Math.max(0, this.app.playback.time.get() - f.clip.start))
  }

  /** Timeline → source mapping of a clip (its own or its link group's speed curve). */
  timeMap(clip: Clip | Id): TimeMap {
    const c = typeof clip === 'string' ? findClip(this.app.timeline(), clip)?.clip : clip
    return c ? clipTimeMap(c, this.app.timeline(), this.app.registries) : constantMap(1)
  }

  /** Evaluated value of a param at the playhead. */
  paramValue(clipId: Id, propertyId: Id, paramId: string): unknown {
    const f = findClip(this.app.timeline(), clipId)
    const p = f?.clip.properties.find((x) => x.id === propertyId)
    const def = p && this.paramDef(p.type, paramId)
    if (!p || !def) return undefined
    return evaluateParam(this.app.registries, def, p.params[paramId], this.localTime(clipId))
  }

  /**
   * Set a param. If it's animated, writes a keyframe at the playhead (creating one if needed);
   * otherwise sets the static value. `at` overrides the clip-local time.
   */
  setParam(clipId: Id, propertyId: Id, paramId: string, value: unknown, opts: GestureOpts & { at?: Flicks } = {}) {
    this.writeParams('Change value', clipId, { [propertyId]: { [paramId]: value } }, `param:${propertyId}:${paramId}`, opts)
  }

  /** Set several params of one property in a single undoable step (e.g. scale + position from a handle drag). */
  setParams(clipId: Id, propertyId: Id, values: Record<string, unknown>, opts: GestureOpts & { at?: Flicks } = {}) {
    this.writeParams('Change values', clipId, { [propertyId]: values }, `params:${propertyId}`, opts)
  }

  /** Set params across several properties of one clip in a single undoable step: `{ [propertyId]: { [paramId]: value } }`. */
  setClipParams(clipId: Id, byProperty: Record<Id, Record<string, unknown>>, opts: GestureOpts & { at?: Flicks } = {}) {
    this.writeParams('Change values', clipId, byProperty, `clipparams:${clipId}`, opts)
  }

  private writeParams(label: string, clipId: Id, byProperty: Record<Id, Record<string, unknown>>, key: string, opts: GestureOpts & { at?: Flicks }) {
    const at = opts.at ?? this.localTime(clipId)
    this.doc.transact(
      label,
      (d) => {
        const clip = this.findDraftClip(d, clipId)?.clip
        for (const [propertyId, values] of Object.entries(byProperty)) {
          const p = clip?.properties.find((x) => x.id === propertyId)
          if (!p) continue
          for (const [paramId, value] of Object.entries(values)) {
            const pv = (p.params[paramId] ??= { value })
            if (pv.keyframes && pv.keyframes.length) {
              const k = keyframeAt(pv as ParamValue, at)
              if (k) k.value = value
              else {
                pv.keyframes.push({ id: uid('kf_'), t: at, value, easing: { id: this.defaultEasing() } })
                pv.keyframes.sort((a, b) => a.t - b.t)
              }
            } else pv.value = value
          }
        }
      },
      this.gesture(key, opts)
    )
    this.endGesture(opts)
  }

  private defaultEasing() {
    return this.app.settings.get<string>('keyframes.defaultEasing') ?? 'ease-in-out'
  }

  /** Toggle keyframe at playhead: add one (with the current value) or remove the one there. */
  toggleKeyframe(clipId: Id, propertyId: Id, paramId: string, at?: Flicks) {
    const t = at ?? this.localTime(clipId)
    const current = this.paramValue(clipId, propertyId, paramId)
    this.doc.transact('Toggle keyframe', (d) => {
      const p = this.findDraftClip(d, clipId)?.clip.properties.find((x) => x.id === propertyId)
      if (!p) return
      const pv = (p.params[paramId] ??= { value: current })
      const existing = keyframeAt(pv as ParamValue, t)
      if (existing) {
        pv.keyframes = pv.keyframes!.filter((k) => k.id !== existing.id)
        if (pv.keyframes.length === 0) {
          pv.value = existing.value
          delete pv.keyframes
        }
      } else {
        pv.keyframes ??= []
        pv.keyframes.push({ id: uid('kf_'), t, value: structuredClone(current), easing: { id: this.defaultEasing() } })
        pv.keyframes.sort((a, b) => a.t - b.t)
      }
    })
  }

  addKeyframe(clipId: Id, propertyId: Id, paramId: string, t: Flicks, value: unknown, easing?: EasingRef) {
    this.doc.transact('Add keyframe', (d) => {
      const p = this.findDraftClip(d, clipId)?.clip.properties.find((x) => x.id === propertyId)
      if (!p) return
      const pv = (p.params[paramId] ??= { value })
      pv.keyframes ??= []
      const existing = keyframeAt(pv as ParamValue, t)
      if (existing) {
        existing.value = value
        if (easing) existing.easing = easing
      } else pv.keyframes.push({ id: uid('kf_'), t, value, easing: easing ?? { id: this.defaultEasing() } })
      pv.keyframes.sort((a, b) => a.t - b.t)
    })
  }

  /** Remove all keyframes of a param, keeping the value at the playhead. */
  clearKeyframes(clipId: Id, propertyId: Id, paramId: string) {
    const current = this.paramValue(clipId, propertyId, paramId)
    this.doc.transact('Clear keyframes', (d) => {
      const p = this.findDraftClip(d, clipId)?.clip.properties.find((x) => x.id === propertyId)
      const pv = p?.params[paramId]
      if (!pv) return
      delete pv.keyframes
      pv.value = current
    })
  }

  private forKeyframes(d: DProject, sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }[], fn: (pv: Draft<ParamValue>, kfIndex: number) => void) {
    for (const s of sel) {
      const p = this.findDraftClip(d, s.clipId)?.clip.properties.find((x) => x.id === s.propertyId)
      const pv = p?.params[s.paramId]
      if (!pv?.keyframes) continue
      const i = pv.keyframes.findIndex((k) => k.id === s.keyframeId)
      if (i >= 0) fn(pv, i)
    }
  }

  removeKeyframes(sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }[]) {
    this.doc.transact('Delete keyframes', (d) => {
      const ids = new Set(sel.map((s) => s.keyframeId))
      this.forKeyframes(d, sel, (pv) => {
        if (!pv.keyframes) return
        const remaining = pv.keyframes.filter((k) => !ids.has(k.id))
        if (remaining.length === 0) {
          pv.value = pv.keyframes[0].value
          delete pv.keyframes
        } else pv.keyframes = remaining
      })
    })
  }

  moveKeyframes(sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }[], delta: Flicks, opts?: GestureOpts) {
    this.doc.transact(
      'Move keyframes',
      (d) => {
        const touched = new Set<Draft<ParamValue>>()
        this.forKeyframes(d, sel, (pv, i) => {
          pv.keyframes![i].t = Math.round(pv.keyframes![i].t + delta)
          touched.add(pv)
        })
        for (const pv of touched) pv.keyframes!.sort((a, b) => a.t - b.t)
      },
      this.gesture('kfmove', opts)
    )
    this.endGesture(opts)
  }

  setKeyframeTime(sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }, t: Flicks, opts?: GestureOpts) {
    this.doc.transact(
      'Move keyframe',
      (d) => {
        this.forKeyframes(d, [sel], (pv, i) => {
          pv.keyframes![i].t = Math.round(t)
          pv.keyframes!.sort((a, b) => a.t - b.t)
        })
      },
      this.gesture('kfmove', opts)
    )
    this.endGesture(opts)
  }

  setKeyframeEasing(sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }[], easing: EasingRef, opts?: GestureOpts) {
    this.doc.transact(
      'Change easing',
      (d) => this.forKeyframes(d, sel, (pv, i) => (pv.keyframes![i].easing = structuredClone(easing))),
      this.gesture('easing', opts)
    )
    this.endGesture(opts)
  }

  setKeyframeValue(sel: { clipId: Id; propertyId: Id; paramId: string; keyframeId: Id }, value: unknown, opts?: GestureOpts) {
    this.doc.transact(
      'Change keyframe',
      (d) => this.forKeyframes(d, [sel], (pv, i) => (pv.keyframes![i].value = value)),
      this.gesture(`kfval:${sel.keyframeId}`, opts)
    )
    this.endGesture(opts)
  }

  /** Neighbouring keyframe times (timeline time) across all params of a clip, for ◀ ▶ navigation. */
  adjacentKeyframe(clipId: Id, dir: -1 | 1, propertyId?: Id, paramId?: string): Flicks | null {
    const f = findClip(this.app.timeline(), clipId)
    if (!f) return null
    const now = this.app.playback.time.get() - f.clip.start
    let best: Flicks | null = null
    for (const p of f.clip.properties) {
      if (propertyId && p.id !== propertyId) continue
      for (const [pid, pv] of Object.entries(p.params)) {
        if (paramId && pid !== paramId) continue
        for (const k of pv.keyframes ?? []) {
          if (dir > 0 && k.t > now + KF_EPSILON && (best === null || k.t < best)) best = k.t
          if (dir < 0 && k.t < now - KF_EPSILON && (best === null || k.t > best)) best = k.t
        }
      }
    }
    return best === null ? null : best + f.clip.start
  }

  // ───────────────────────── project ─────────────────────────

  setProjectSettings(patch: Partial<Project['settings']>) {
    this.doc.transact('Project settings', (d) => Object.assign(d.settings, patch))
  }

  renameProject(name: string) {
    this.doc.transact('Rename project', (d) => {
      d.name = name
    })
  }

  addMarker(t: Flicks, name = '') {
    this.doc.transact('Add marker', (d) => {
      this.tl(d).markers.push({ id: uid('mk_'), t, name })
    })
  }

  setPluginData(pluginId: string, data: unknown) {
    this.doc.transact('Plugin data', (d) => {
      d.pluginData[pluginId] = data as never
    })
  }

  /** Seconds → flicks convenience for plugin/MCP code. */
  seconds(s: number) {
    return Math.round(s * FLICKS)
  }
}
