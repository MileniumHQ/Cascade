import { CascadeApp, type CascadeAPI } from '@core/app'
import { clipEnd, findClip, uid, type Project, type Clip, type Id, type PropertyInstance } from '@shared/project'
import { MIN_CLIP } from '@core/timeline-ops'
import { sourceSpan, type TimeMap } from '@core/time-remap'
import { evaluateParam } from '@core/evaluate'
import { ANCHOR, SOURCE_ANCHOR, TIME_TEXT, editSchema, type Edit } from '../../../main/mcp/catalog'
import type { ParamDef } from '@core/plugin-api'
import { FLICKS, frameToFlicks, secondsToFlicks, type Flicks, type FrameRate } from '@shared/time'
import { buildIndex, buildSourceIndex, findSpoken, type Analyses } from './transcript'
import { clock } from './clock'
export { clock }

/** Stable aliases for this editor lifetime; full document ids also work. */
export class Ids {
  private short = new Map<string, string>()
  private full = new Map<string, string>()
  private counts = new Map<string, number>()
  show(value: string, prefix: string): string {
    if (!this.short.has(value)) {
      const n = (this.counts.get(prefix) ?? 0) + 1; this.counts.set(prefix, n)
      const alias = `${prefix}${n}`; this.short.set(value, alias); this.full.set(alias, value)
    }
    return this.short.get(value)!
  }
  resolve(value: string): string { return this.full.get(value) ?? value }
}
/** An edit with every anchor resolved to integer flicks. */
type Resolved = Edit extends infer E ? E extends unknown ? { [K in keyof E]: K extends 'start' | 'end' | 'time' | 'duration' ? Extract<E[K], number | undefined> : E[K] } : never : never

/** Signed anchor offset (+80ms, -0.5s, +2f) in flicks. */
function anchorOffset(sign: string | undefined, amount: string | undefined, unit: string | undefined, fps: FrameRate) {
  if (!amount) return 0
  const per = unit === 'ms' ? FLICKS / 1000 : unit === 'f' ? FLICKS * fps.den / fps.num : FLICKS
  return Math.round(Number(amount) * per) * (sign === '-' ? -1 : 1)
}

/** Flicks for time text: a clock time (HH:MM:SS.mmm, MM:SS.s, decimal seconds after the dot) or an amount (83.5s, 500ms, 12f). */
export function parseTimeText(value: string, fps: FrameRate): Flicks {
  const match = TIME_TEXT.exec(value)
  if (!match) throw new Error(`Invalid time ${value}`)
  const [, h, m, s, fraction, amount, unit] = match
  if (amount) return anchorOffset('+', amount, unit, fps)
  if (Number(s) >= 60 || (h !== undefined && Number(m) >= 60)) throw new Error(`Invalid time ${value}`)
  return secondsToFlicks(Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${fraction ?? 0}`))
}

/** Timeline flicks for a transcript anchor (w12, w12.end, s3.start, w12.end+80ms, s3.end+2f) in `project`. */
export function resolveAnchor(project: Project, analyses: Analyses | undefined, ids: Ids, value: string, timeMap?: (clip: Clip) => TimeMap): number {
  if (TIME_TEXT.test(value)) return parseTimeText(value, project.settings.fps)
  if (SOURCE_ANCHOR.test(value)) throw new Error(`${value} is a source anchor; use it in add_clip sourceIn/sourceOut. Timeline times take w#/s# ids from transcript_get without mediaId`)
  const match = ANCHOR.exec(value)
  if (!match) throw new Error(`Invalid anchor ${value}`)
  const [, id, edge, sign, amount, unit] = match
  const key = ids.resolve(id)
  const index = buildIndex(project, analyses ?? new Map(), timeMap)
  const item = index.sentences.find(x => x.key === key) ?? index.words.find(x => x.key === key)
  if (!item) throw new Error(`${id} is not on the timeline (cut already, or not an id from transcript_get/transcript_search)`)
  return Math.max(0, (edge === 'end' ? item.end : item.start) + anchorOffset(sign, amount, unit, project.settings.fps))
}

/** Source flicks for a source anchor (m1:w12, m1:s3.end-40ms) from transcript_get with mediaId. */
export function resolveSourceAnchor(project: Project, analyses: Analyses | undefined, ids: Ids, value: string): { mediaId: Id; t: Flicks } {
  const match = SOURCE_ANCHOR.exec(value)
  if (!match) throw new Error(`Invalid source anchor ${value}`)
  const [, media, id, edge, sign, amount, unit] = match
  const mediaId = ids.resolve(media)
  const m = project.media[mediaId]
  if (!m?.path) throw new Error(`${media} in ${value} is not a file-backed source from media_list`)
  const index = buildSourceIndex(mediaId, analyses?.get(m.path))
  const n = Number(id.slice(1))
  const item = id[0] === 'w' ? index.words[n - 1] : index.sentences[n - 1]
  if (!item) throw new Error(`${value}: ${media} has no ${id}. Run media_analyze, then read ids with transcript_get mediaId=${media}`)
  const t = (edge === 'end' ? item.end : item.start) + anchorOffset(sign, amount, unit, project.settings.fps)
  return { mediaId, t: Math.max(0, Math.min(m.meta.duration ?? Number.MAX_SAFE_INTEGER, t)) }
}

/** Remove one clip without its linked partners. */
function removeClip(copy: CascadeApp, clipId: Id) {
  copy.doc.transact('Remove clip', d => { for (const t of d.timelines[d.activeTimeline].tracks) t.clips = t.clips.filter(c => c.id !== clipId) })
}

export function staging(app: CascadeAPI): CascadeApp {
  const copy = new CascadeApp('editor', null, structuredClone(app.project()))
  Object.assign(copy.registries, app.registries)
  copy.settings.values.set(app.settings.values.get())
  return copy
}
export function commit(app: CascadeAPI, project: Project, label: string) {
  app.doc.transact(`Agent: ${label}`, draft => { Object.assign(draft, project) })
}
export function validateValue(def: ParamDef, value: unknown, fonts?: string[]) {
  if (['number', 'angle'].includes(def.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) throw new Error(`Invalid ${def.id}; expected finite number in ${def.min ?? '-∞'}..${def.max ?? '∞'}`)
  } else if (def.type === 'vec2') {
    if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${def.id} needs two finite numbers (frame fractions for spatial units)`)
  } else if (def.type === 'toggle' && typeof value !== 'boolean') throw new Error(`${def.id} needs a boolean`)
  else if (['text', 'font', 'color', 'select'].includes(def.type) && typeof value !== 'string') throw new Error(`${def.id} needs a string`)
  if (def.options && !def.options.some(o => o.value === value)) throw new Error(`Unknown ${def.id} option; inspect registry_list`)
  // A missing font silently falls back to another face; refuse it instead.
  if (def.type === 'font' && fonts?.length && !fonts.some(f => f.toLowerCase() === String(value).toLowerCase())) {
    const words = String(value).toLowerCase().split(/\s+/).filter(Boolean)
    const close = fonts.filter(f => words.some(w => f.toLowerCase().includes(w))).slice(0, 12)
    throw new Error(`Font "${value}" is not installed${close.length ? `; similar: ${close.join(', ')}` : ''}. registry_list lists every font`)
  }
}
/** Whole frames (at least one) that fit in `d`. */
function floorFrames(d: number, fps: FrameRate): Flicks {
  return frameToFlicks(Math.max(1, Math.floor(d * fps.num / (FLICKS * fps.den) + 1e-9)), fps)
}
/** Deterministic PRNG for wiggle (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ApplyOptions {
  /** Installed font families; font params must name one. */
  fonts?: string[]
  /** Validate and report without committing. */
  dryRun?: boolean
  /** Beat grids from beat_grid, by source path, in source flicks. */
  beats?: Map<string, { beats: Flicks[]; downbeats: Flicks[] }>
}

export function applyEdits(app: CascadeAPI, input: unknown, ids: Ids, analyses?: Analyses, options: ApplyOptions = {}) {
  const ops = editSchema.array().min(1).max(300).parse((input as { ops: unknown }).ops)
  const copy = staging(app)
  const fps = copy.project().settings.fps
  // Edits replace clip objects, so untouched clips keep their identity.
  const untouched = new Set(copy.timeline().tracks.flatMap(t => t.clips))
  const refs = new Map<string, string>()
  const resolve = (v: string) => refs.get(v) ?? ids.resolve(v)
  // Clips an earlier operation removed (a delete takes the linked partner with it), so a later reference says why.
  const gone = new Map<string, string>()
  const editable = (id: string) => {
    const f = findClip(copy.timeline(), resolve(id))
    if (!f && gone.has(resolve(id))) throw new Error(`Clip ${id} was already removed by ${gone.get(resolve(id))}; drop this operation`)
    if (!f) throw new Error(`Unknown clip ${id}; refresh timeline_get`)
    if (f.track.locked || (f.clip.linkId && copy.timeline().tracks.some(t => t.locked && t.clips.some(c => c.linkId === f.clip.linkId)))) throw new Error(`Clip ${id} or its linked audio is locked`)
    return f
  }
  const track = (value: string | undefined, type: string) => {
    const kind = copy.registries.mediaTypes.get(type)?.track
    const tr = value ? copy.timeline().tracks.find(t => t.id === resolve(value)) : copy.timeline().tracks.find(t => t.kind === kind && !t.locked)
    if (!tr || tr.locked || tr.kind !== kind) throw new Error(`Invalid/locked destination track ${value ?? kind}`)
    return tr.id
  }
  const trackEnd = (trackId: string) => Math.max(0, ...(copy.timeline().tracks.find(t => t.id === trackId)?.clips.map(clipEnd) ?? []))
  const remapType = copy.registries.properties.all().find(p => p.timeRemap)
  const partners = (clip: Clip) => clip.linkId ? copy.timeline().tracks.flatMap(t => t.clips.filter(c => c.id !== clip.id && c.linkId === clip.linkId)) : []
  // Speed (the time-remap property) belongs to the link pair: a partner's instance serves both clips.
  const findProperty = (clip: Clip, propertyId: string): { clip: Clip; prop: PropertyInstance } | null => {
    const match = (p: PropertyInstance) => p.id === resolve(propertyId) || p.type === propertyId
    const own = clip.properties.find(match)
    if (own) return { clip, prop: own }
    for (const c of partners(clip)) {
      const p = c.properties.find(p => match(p) && p.type === remapType?.id)
      if (p) return { clip: c, prop: p }
    }
    return null
  }
  // Like the UI, a linked pair's speed lives on its picture clip.
  const pictureOf = (clip: Clip) => remapType && copy.registries.mediaTypes.get(clip.type)?.track !== 'visual'
    ? partners(clip).find(c => copy.registries.mediaTypes.get(c.type)?.track === 'visual' && copy.edit.propertyApplies(remapType, c))
    : undefined
  // Split boundaries explicitly, then remove the interval and shift all unlocked tracks equally (including gaps).
  const ripple = (start: number, end: number) => {
    for (const t of [end, start]) {
      const targets = copy.timeline().tracks.filter(t => !t.locked).flatMap(tr => tr.clips.filter(c => c.start < t && clipEnd(c) > t).map(c => c.id))
      for (const id of targets) editable(id)
      if (targets.length) copy.edit.splitAt(t, targets)
    }
    const remove = copy.timeline().tracks.filter(t => !t.locked).flatMap(t => t.clips.filter(c => c.start >= start && clipEnd(c) <= end).map(c => c.id))
    for (const id of remove) editable(id)
    copy.edit.deleteClips(remove)
    for (const tr of copy.timeline().tracks.filter(t => !t.locked)) for (const c of tr.clips) if (c.start >= end) editable(c.id)
    copy.edit.moveClips(copy.timeline().tracks.filter(t => !t.locked).flatMap(t => t.clips.filter(c => c.start >= end).map(c => ({ clipId: c.id, trackId: t.id, start: c.start - (end - start) }))))
    copy.doc.transact('Ripple markers', d => { const tl = d.timelines[d.activeTimeline]; tl.markers = tl.markers.filter(m => m.t < start || m.t >= end); for (const m of tl.markers) if (m.t >= end) m.t -= end - start })
  }
  // Transcript anchors (w12.end+80ms) resolve against the staged timeline as edited so far.
  const anchor = (value: string) => resolveAnchor(copy.project(), analyses, ids, value, (c) => copy.edit.timeMap(c))
  /** Clip-local flicks: numbers as given, anchors converted from timeline time. */
  const local = (value: number | string, clip: Clip) => {
    const t = typeof value === 'string' ? anchor(value) - clip.start : value
    if (t < 0) throw new Error(`${value} is before the clip start`)
    return t
  }
  const sourceTime = (value: number | string, mediaId: Id) => {
    if (typeof value === 'number') return value
    if (TIME_TEXT.test(value)) return parseTimeText(value, fps)
    const r = resolveSourceAnchor(copy.project(), analyses, ids, value)
    if (r.mediaId !== mediaId) throw new Error(`${value} belongs to another source than this clip's mediaId`)
    return r.t
  }
  let retargeted = ''
  const resolveTimes = (raw: Edit): Resolved => {
    retargeted = ''
    const op = { ...raw } as Record<string, unknown>
    for (const key of ['start', 'end', 'time'] as const) if (typeof op[key] === 'string') op[key] = anchor(op[key] as string)
    if (typeof op.duration === 'string' && !(op.duration = parseTimeText(op.duration, fps))) throw new Error('duration must be positive')
    // An anchor names a moment in a source. If the addressed clip was cut into pieces (earlier in this
    // batch or before), use the piece of the same source on the same track that holds that moment.
    if ((raw.op === 'split' || raw.op === 'add_keyframe' || raw.op === 'set_param') && typeof raw.time === 'string') {
      const at = raw.time, { clip, track: tr } = editable(raw.clipId), t = op.time as number
      if (t < clip.start || t > clipEnd(clip)) {
        const piece = tr.clips.find(c => c.mediaId === clip.mediaId && c.start <= t && t <= clipEnd(c))
        if (!piece) throw new Error(`${at} is outside clip ${raw.clipId} and no clip of the same source on its track holds it`)
        op.clipId = piece.id
        retargeted = `${raw.clipId} → ${ids.show(piece.id, 'c')} (piece holding ${at})`
      }
    }
    // Keyframe/parameter times are clip-local; anchors are timeline times.
    if ((raw.op === 'add_keyframe' || raw.op === 'set_param') && typeof raw.time === 'string') op.time = (op.time as number) - editable(op.clipId as string).clip.start
    if (typeof op.time === 'number' && op.time < 0) throw new Error(`${raw.op} time resolves before the clip start`)
    return op as Resolved
  }
  const setRef = (name: string | undefined, id: string) => {
    if (!name) return
    if (refs.has(name) || ids.resolve(name) !== name) throw new Error(`Duplicate/reserved ref ${name}`)
    refs.set(name, id)
  }
  const span = (clip: Clip) => `[${clip.start}, ${clipEnd(clip)})`
  const trackOf = (value: string) => {
    const tr = copy.timeline().tracks.find(t => t.id === resolve(value))
    if (!tr) throw new Error(`Unknown track ${value}; refresh timeline_get`)
    return tr
  }
  // Reorder within a kind, keeping the slots the kinds occupy.
  const moveTrack = (trackId: string, index: number) => copy.doc.transact('Move track', d => {
    const tl = d.timelines[d.activeTimeline], kind = tl.tracks.find(t => t.id === trackId)!.kind
    const same = tl.tracks.filter(t => t.kind === kind && t.id !== trackId)
    same.splice(Math.min(index, same.length), 0, tl.tracks.find(t => t.id === trackId)!)
    let i = 0
    tl.tracks = tl.tracks.map(t => t.kind === kind ? same[i++] : t)
  })
  const clipIds = () => new Set(copy.timeline().tracks.flatMap(t => t.clips.map(c => c.id)))
  const results: string[] = []
  for (const [index, raw] of ops.entries()) {
    const before = clipIds()
    try {
      const op = resolveTimes(raw)
      let created: string | null | undefined
      let note = ''
      if ('ref' in op && op.ref && (refs.has(op.ref) || ids.resolve(op.ref) !== op.ref)) throw new Error(`Duplicate/reserved ref ${op.ref}`)
      if (op.op === 'add_clip') {
        const media = copy.project().media[resolve(op.mediaId)]
        if (!media) throw new Error(`Unknown media ${op.mediaId}`)
        if (op.duration !== undefined && op.sourceOut !== undefined) throw new Error('Give duration or sourceOut, not both')
        const mt = copy.registries.mediaTypes.get(media.type)
        const sourceDuration = mt?.timeBased ? media.meta.duration : undefined
        const speed = op.speed ?? 1
        const sourceIn = op.sourceIn === undefined ? 0 : sourceTime(op.sourceIn, media.id)
        const sourceOut = op.sourceOut === undefined ? undefined : sourceTime(op.sourceOut, media.id)
        if (sourceOut !== undefined && sourceOut <= sourceIn) throw new Error('sourceOut must be after sourceIn')
        if (sourceDuration !== undefined && (sourceOut ?? sourceIn) > sourceDuration) throw new Error('Source range exceeds the source duration')
        if ((op.speed !== undefined || op.reverse) && !mt?.timeBased) throw new Error('speed/reverse need time-based media')
        if (op.reverse && !remapType?.timeReverse) throw new Error('Reverse needs the Speed property; inspect registry_list')
        // Timeline duration: given, or the source range played at `speed`, in whole frames.
        let duration = op.duration
        if (duration === undefined) {
          const out = sourceOut ?? sourceDuration
          duration = out !== undefined ? floorFrames((out - sourceIn) / speed, fps) : copy.edit.buildClip(media, 0)?.duration
          if (!duration) throw new Error('Media type unavailable; inspect registry_list')
        }
        const used = Math.round(duration * speed)
        if (sourceDuration !== undefined && sourceIn + used > sourceDuration + 1) throw new Error(`Clip exceeds source duration (needs ${sourceIn + used}, source ends at ${sourceDuration}); shorten duration or lower speed`)
        const audioType = media.meta.hasAudio ? mt?.linkedAudioType : undefined
        const videoTrack = track(op.trackId, media.type)
        const audioTrack = audioType ? track(op.audioTrackId, audioType) : undefined
        let start = op.start ?? Math.max(trackEnd(videoTrack), audioTrack ? trackEnd(audioTrack) : 0)
        const placed: string[] = []
        for (let i = 0; i < (op.repeat ?? 1); i++) {
          const name = op.ref && (i === 0 ? op.ref : `${op.ref}.${i + 1}`)
          const clip = copy.edit.buildClip(media, start)
          if (!clip) throw new Error('Media type unavailable; inspect registry_list')
          // A reversed clip starts at the end of its source range and runs down to sourceIn.
          clip.sourceIn = op.reverse ? sourceIn + used : sourceIn
          clip.start = start; clip.duration = duration
          const id = copy.edit.insertClip(clip, videoTrack)
          if (!id) throw new Error('Could not place the clip')
          setRef(name, id)
          let line = `${ids.show(id, 'c')}${name ? ` (${name})` : ''} ${span(clip)}`
          // Match the UI's linked audio behavior, using the requested trimmed source range.
          if (audioType && audioTrack) {
            const audio = copy.edit.buildClip(media, start, audioType)
            if (audio) {
              const linkId = `agent_${id}`
              copy.doc.transact('Link audio', d => { findClip(d.timelines[d.activeTimeline], id)!.clip.linkId = linkId })
              audio.start = start; audio.duration = duration; audio.sourceIn = clip.sourceIn; audio.linkId = linkId
              const audioId = copy.edit.insertClip(audio, audioTrack)
              if (audioId) {
                copy.doc.transact('Link audio', d => { findClip(d.timelines[d.activeTimeline], audioId)!.clip.linkId = linkId })
                setRef(name && `${name}.audio`, audioId)
                line += ` + linked audio ${ids.show(audioId, 'c')}${name ? ` (${name}.audio)` : ''}`
              }
            }
          }
          // Speed lives on the pair's picture clip; the linked audio follows it.
          if (op.speed !== undefined || op.reverse) {
            copy.edit.updateClip(id, { speed })
            if (op.reverse) {
              const owner = findProperty(findClip(copy.timeline(), id)!.clip, remapType!.id)
              if (!owner) throw new Error('Could not add the Speed property')
              copy.edit.setParam(owner.clip.id, owner.prop.id, remapType!.timeReverse!, true, { at: 0 })
            }
          }
          placed.push(line)
          start += duration
        }
        results.push(`${index + 1}. add_clip: ok ${placed.join('; ')}`)
        continue
      } else if (op.op === 'add_text') {
        const mediaId = copy.edit.addGenerated('text')
        if (!mediaId) throw new Error('Text generator unavailable')
        const destination = track(op.trackId, copy.project().media[mediaId].type)
        const start = op.start ?? trackEnd(destination)
        const clip = copy.edit.buildClip(copy.project().media[mediaId], start)
        if (!clip) throw new Error('Text media type unavailable')
        const text = clip.properties.find(p => p.type === 'text')
        if (!text) throw new Error('Text property unavailable')
        text.params.text = { value: op.text }; clip.name = op.text.slice(0, 80) || 'Text'
        clip.start = start; clip.duration = op.duration ?? 5 * FLICKS
        created = copy.edit.insertClip(clip, destination)
        note = ` ${span(clip)}`
      } else if (op.op === 'add_track') {
        const id = copy.edit.addTrack(op.kind, { name: op.name })
        if (op.index !== undefined) moveTrack(id, op.index)
        setRef(op.ref, id)
        results.push(`${index + 1}. add_track: ok ${ids.show(id, 't')}${op.ref ? ` (${op.ref})` : ''} ${copy.timeline().tracks.find(t => t.id === id)!.name}`)
        continue
      } else if (op.op === 'remove_track') {
        const tr = trackOf(op.trackId)
        if (tr.locked) throw new Error(`Track ${op.trackId} is locked`)
        const clips = tr.clips.map(c => c.id)
        for (const id of clips) editable(id)
        copy.edit.deleteClips(clips)
        copy.edit.removeTrack(tr.id)
        note = ` (${clips.length} clips)`
      } else if (op.op === 'update_track') {
        const patch = Object.fromEntries(Object.entries({ name: op.name, locked: op.locked, muted: op.muted, hidden: op.hidden }).filter(([, v]) => v !== undefined))
        if (!Object.keys(patch).length) throw new Error('Give name, locked, muted or hidden')
        copy.edit.updateTrack(trackOf(op.trackId).id, patch)
      } else if (op.op === 'move_track') moveTrack(trackOf(op.trackId).id, op.index)
      else if (op.op === 'copy_properties') {
        const from = editable(op.fromClipId).clip
        const wanted = (p: PropertyInstance) => op.properties ? op.properties.some(x => resolve(x) === p.id || x === p.type) : p.type !== remapType?.id
        const sources = from.properties.filter(wanted)
        if (!sources.length) throw new Error(`${op.fromClipId} has none of those properties`)
        let added = 0, skipped = 0
        for (const target of op.toClipIds) {
          const to = editable(target).clip
          if (to.id === from.id) continue
          for (const src of sources) {
            const def = copy.registries.properties.get(src.type)
            if (!def || !copy.edit.propertyApplies(def, to)) { skipped++; continue }
            let propId = to.properties.find(p => p.type === src.type)?.id
            if (!propId) { propId = copy.edit.addProperty(to.id, src.type) ?? undefined; added++ }
            if (!propId) { skipped++; continue }
            const keys = Object.keys(src.params).filter(k => op.params ? op.params.includes(k) : !(src.type === 'text' && k === 'text'))
            copy.doc.transact('Copy properties', d => {
              const prop = findClip(d.timelines[d.activeTimeline], to.id)!.clip.properties.find(p => p.id === propId)!
              for (const k of keys) prop.params[k] = structuredClone(src.params[k])
              prop.enabled = src.enabled
            })
          }
        }
        note = ` to ${op.toClipIds.length} clips${added ? `, added ${added} properties` : ''}${skipped ? `, skipped ${skipped} that don't apply` : ''}`
      } else if (op.op === 'merge_tracks') {
        const into = trackOf(op.into)
        if (into.locked) throw new Error(`Track ${op.into} is locked`)
        let moved = 0
        for (const value of op.trackIds) {
          const tr = trackOf(value)
          if (tr.id === into.id) continue
          if (tr.locked) throw new Error(`Track ${value} is locked`)
          if (tr.kind !== into.kind) throw new Error(`${value} is a ${tr.kind} track and ${op.into} a ${into.kind} track`)
          const clips = structuredClone(tr.clips) as Clip[]
          copy.edit.removeTrack(tr.id)
          copy.edit.placeClips(into.id, clips.sort((a, b) => a.start - b.start), { label: 'Merge tracks' })
          moved += clips.length
        }
        note = ` ${moved} clips onto ${ids.show(into.id, 't')} ${into.name}`
      } else if (op.op === 'duck') {
        const index = buildIndex(copy.project(), analyses ?? new Map(), (c) => copy.edit.timeMap(c))
        const ms = (v: number | string | undefined, d: number) => v === undefined ? d * FLICKS / 1000 : typeof v === 'string' ? parseTimeText(v, fps) : v
        const attack = ms(op.attack, 150), release = ms(op.release, 400), mergeGap = ms(op.mergeGap, 800)
        const targets = op.clipIds.map(v => editable(v).clip)
        const own = new Set(targets.flatMap(c => [c.id, ...partners(c).map(x => x.id)]))
        const words = index.words.filter(w => !own.has(w.clipId)).sort((a, b) => a.start - b.start)
        if (!words.length) throw new Error('No transcribed speech on the timeline to duck under; run media_analyze on the speech sources')
        // Speech segments: words merged across gaps shorter than mergeGap.
        const segments: [Flicks, Flicks][] = []
        for (const w of words) {
          const last = segments.at(-1)
          if (last && w.start - last[1] < mergeGap) last[1] = Math.max(last[1], w.end)
          else segments.push([w.start, w.end])
        }
        let keys = 0
        for (const clip of targets) {
          if (copy.registries.mediaTypes.get(clip.type)?.track !== 'audio') throw new Error(`${ids.show(clip.id, 'c')} is not an audio clip`)
          let prop = clip.properties.find(p => p.type === 'volume')
          if (!prop) {
            const id = copy.edit.addProperty(clip.id, 'volume')
            prop = id ? findClip(copy.timeline(), clip.id)!.clip.properties.find(p => p.id === id) : undefined
            if (!prop) throw new Error('The volume property is unavailable')
          }
          const gain = prop.params.gain
          if (gain?.keyframes?.length) throw new Error(`${ids.show(clip.id, 'c')} already has volume keyframes; clear_keyframes first`)
          const base = Number(gain?.value ?? 0), low = Math.max(-60, base + op.amount)
          const points: { t: Flicks; v: number }[] = []
          for (const [s0, e0] of segments) {
            const s = s0 - clip.start, e = e0 - clip.start
            if (e + release <= 0 || s - attack >= clip.duration) continue
            const prev = points.at(-1)
            // Overlapping fades: stay down instead of bouncing.
            if (prev && s - attack <= prev.t) { points.splice(-2, 2, { t: Math.min(clip.duration, e), v: low }, { t: Math.min(clip.duration, e + release), v: base }); continue }
            points.push({ t: Math.max(0, s - attack), v: s - attack < 0 ? low : base }, { t: Math.max(0, s), v: low }, { t: Math.min(clip.duration, e), v: low }, { t: Math.min(clip.duration, e + release), v: base })
          }
          const unique = points.filter((p, i) => i === 0 || p.t > points[i - 1].t)
          for (const p of unique) copy.edit.addKeyframe(clip.id, prop.id, 'gain', p.t, p.v, { id: 'ease-in-out' })
          keys += unique.length
        }
        note = ` ${keys} volume keyframes under ${segments.length} speech segments (${op.amount} dB)`
      } else if (op.op === 'snap_to_beats') {
        const beat = editable(op.beatClipId).clip
        const media = beat.mediaId ? copy.project().media[beat.mediaId] : undefined
        const grid = media?.path ? options.beats?.get(media.path) : undefined
        if (!grid) throw new Error(`No beat grid for ${op.beatClipId}; run beat_grid clipId=${op.beatClipId} first`)
        const map = copy.edit.timeMap(beat)
        if (map.constant === null || map.reversed) throw new Error('snap_to_beats needs the music clip at a constant forward speed')
        const times = (op.to === 'downbeats' ? grid.downbeats : grid.beats).map(t => beat.start + Math.round((t - beat.sourceIn) / map.constant!)).filter(t => t >= beat.start && t <= clipEnd(beat))
        if (!times.length) throw new Error(`${op.beatClipId} has no ${op.to} in its range`)
        const maxShift = op.maxShift === undefined ? FLICKS / 4 : typeof op.maxShift === 'string' ? parseTimeText(op.maxShift, fps) : op.maxShift
        const nearest = (t: Flicks) => times.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a)
        let snapped = 0, far = 0, keyed = 0
        for (const value of op.clipIds) {
          const { clip, track: tr } = editable(value)
          const edge = op.edge === 'start' ? clip.start : clipEnd(clip)
          const target = nearest(edge)
          if (Math.abs(target - edge) > maxShift) far++
          else if (target !== edge) {
            if (op.edge === 'start') copy.edit.moveClips([clip, ...partners(clip)].map(c => ({ clipId: c.id, trackId: c.id === clip.id ? tr.id : findClip(copy.timeline(), c.id)!.track.id, start: c.start + target - edge })))
            else if (target > clip.start + MIN_CLIP) copy.edit.trimClip(clip.id, 'end', target)
            snapped++
          }
          if (op.keyframes) {
            copy.doc.transact('Snap keyframes', d => {
              const c = findClip(d.timelines[d.activeTimeline], clip.id)!.clip
              for (const p of c.properties) for (const v of Object.values(p.params)) {
                for (const k of v.keyframes ?? []) {
                  const t = nearest(c.start + k.t) - c.start
                  if (t !== k.t && Math.abs(t - k.t) <= maxShift && t >= 0 && t <= c.duration && !v.keyframes!.some(o => o !== k && o.t === t)) { k.t = t; keyed++ }
                }
                v.keyframes?.sort((a, b) => a.t - b.t)
              }
            })
          }
        }
        note = ` ${snapped} clips to ${op.to}${far ? `, ${far} left alone (more than ${clock(maxShift)} from a beat)` : ''}${op.keyframes ? `, ${keyed} keyframes` : ''}`
      } else if (op.op === 'sync_text') {
        const index = buildIndex(copy.project(), analyses ?? new Map(), (c) => copy.edit.timeMap(c))
        if (!index.words.length) throw new Error('No transcript on the timeline; run media_analyze on the speech sources')
        const words = [...index.words].sort((a, b) => a.start - b.start)
        const padding = op.padding === undefined ? 0 : typeof op.padding === 'string' ? parseTimeText(op.padding, fps) : op.padding
        const lines: string[] = []
        for (const value of op.clipIds) {
          const { clip, track: tr } = editable(value)
          const text = String(clip.properties.find(p => p.type === 'text')?.params.text?.value ?? '')
          if (!text.trim()) throw new Error(`${value} has no text`)
          const runs = findSpoken(words, text)
          if (!runs.length) throw new Error(`"${text.slice(0, 60)}" (${value}) is not in the transcript`)
          const [a, b] = runs.reduce((x, y) => Math.abs(words[y[0]].start - clip.start) < Math.abs(words[x[0]].start - clip.start) ? y : x)
          const start = Math.max(0, words[a].start - padding), end = words[b].end + padding
          copy.edit.moveClips([{ clipId: clip.id, trackId: tr.id, start }])
          copy.edit.trimClip(clip.id, 'end', Math.max(end, start + MIN_CLIP))
          lines.push(`${ids.show(clip.id, 'c')} ${clock(start)}–${clock(end)}`)
        }
        note = ` ${lines.join(', ')}`
      } else if (op.op === 'add_marker') copy.edit.addMarker(op.time, op.name)
      else if (op.op === 'ripple_delete') {
        if (op.end <= op.start) throw new Error('end must be after start')
        ripple(op.start, op.end)
      } else {
        const { clip, track: currentTrack } = editable(op.clipId)
        if (op.op === 'move') {
          const delta = op.start - clip.start
          const linked = copy.timeline().tracks.flatMap(t => t.clips.filter(c => c.id === clip.id || (clip.linkId && c.linkId === clip.linkId)).map(c => ({ clipId: c.id, start: c.start + delta, trackId: c.id === clip.id ? track(op.trackId ?? currentTrack.id, clip.type) : t.id })))
          if (linked.some(m => m.start < 0)) throw new Error('Linked clip would move before zero')
          copy.edit.moveClips(linked)
        } else if (op.op === 'trim') {
          if (op.edge === 'start' ? op.time >= clipEnd(clip) : op.time <= clip.start) throw new Error('Trim would remove entire clip')
          copy.edit.trimClip(clip.id, op.edge, op.time)
        } else if (op.op === 'split') {
          if (op.time <= clip.start || op.time >= clipEnd(clip)) throw new Error('Split must be inside the clip')
          created = copy.edit.splitAt(op.time, [clip.id])?.[0]
          if (!created) throw new Error('Split is too close to the clip edge')
        } else if (op.op === 'delete') copy.edit.deleteClips([clip.id])
        else if (op.op === 'duplicate_clip') {
          const start = op.start ?? clipEnd(clip), delta = start - clip.start
          const linkId = clip.linkId ? uid('ln_') : undefined
          for (const c of [clip, ...partners(clip)]) {
            const dup = structuredClone(c) as Clip
            dup.id = uid('cl_'); dup.start = c.start + delta; dup.linkId = linkId
            for (const p of dup.properties) p.id = uid('pi_')
            if (dup.start < 0) throw new Error('The copy would start before zero')
            const trackId = c.id === clip.id ? (op.trackId ? track(op.trackId, c.type) : currentTrack.id) : findClip(copy.timeline(), c.id)!.track.id
            copy.edit.placeClips(trackId, [dup], { label: 'Duplicate clip' })
            if (c.id === clip.id) created = dup.id
            else note += ` + linked ${ids.show(dup.id, 'c')}`
          }
        } else if (op.op === 'replace_clip') {
          const media = copy.project().media[resolve(op.mediaId)]
          if (!media) throw new Error(`Unknown media ${op.mediaId}`)
          if (media.type !== clip.type) throw new Error(`replace_clip needs a source of the same type (${clip.type}); ${op.mediaId} is ${media.type}`)
          const sourceIn = op.sourceIn === undefined ? clip.sourceIn : sourceTime(op.sourceIn, media.id)
          for (const c of [clip, ...partners(clip)]) {
            const audio = c.id !== clip.id && copy.registries.mediaTypes.get(c.type)?.track === 'audio'
            if (audio && !media.meta.hasAudio) { removeClip(copy, c.id); note += ` (removed linked audio ${ids.show(c.id, 'c')}: the new source has no sound)`; continue }
            copy.doc.transact('Replace clip', d => {
              const x = findClip(d.timelines[d.activeTimeline], c.id)!.clip
              x.mediaId = media.id; x.sourceIn = sourceIn; x.name = media.name
            })
          }
        } else if (op.op === 'add_property') {
          const def = copy.registries.properties.get(op.type)
          if (!def || !copy.edit.propertyApplies(def, clip)) throw new Error(`Property ${op.type} unavailable or incompatible`)
          const shared = def.timeRemap ? findProperty(clip, op.type) : null
          if (shared && shared.clip.id !== clip.id) {
            // One speed per linked pair: reuse the partner's instance rather than adding a second.
            created = shared.prop.id
            note = ` (shared with linked ${ids.show(shared.clip.id, 'c')}; speed applies to both)`
          } else {
            const picture = def.timeRemap ? pictureOf(clip) : undefined
            const target = picture ?? clip
            if (!def.stackable && target.properties.some(p => p.type === op.type)) throw new Error('Property already exists')
            created = copy.edit.addProperty(target.id, op.type)
            if (picture) note = ` (on linked ${ids.show(picture.id, 'c')}; speed applies to both)`
            else if (def.timeRemap && partners(clip).length) note = ' (linked clips follow this speed)'
          }
        } else {
          let found = findProperty(clip, op.propertyId)
          // Setting speed on a clip without one adds it where the UI would: the pair's picture clip.
          if (!found && op.op !== 'remove_property' && op.op !== 'clear_keyframes' && remapType && op.propertyId === remapType.id && copy.edit.propertyApplies(remapType, clip)) {
            copy.edit.addProperty((pictureOf(clip) ?? clip).id, remapType.id)
            found = findProperty(findClip(copy.timeline(), clip.id)!.clip, op.propertyId)
          }
          if (!found) throw new Error(`Unknown property ${op.propertyId}`)
          const { prop } = found, owner = found.clip
          // Clip-local times of the addressed clip, in the owner's clip-local time.
          const shift = clip.start - owner.start
          if (owner.id !== clip.id) note = ` (on linked ${ids.show(owner.id, 'c')}; applies to both)`
          if (op.op === 'remove_property') copy.edit.removeProperty(owner.id, prop.id)
          else if (op.op === 'clear_keyframes') {
            const params = op.paramId ? [op.paramId] : Object.keys(prop.params)
            let cleared = 0
            for (const paramId of params) {
              const def = copy.edit.paramDef(prop.type, paramId)
              if (!def) throw new Error(`Unknown parameter ${paramId}`)
              if (!prop.params[paramId]?.keyframes?.length) continue
              const value = op.value !== undefined ? op.value : evaluateParam(copy.registries, def, prop.params[paramId], shift)
              if (op.value !== undefined) validateValue(def, value, options.fonts)
              copy.doc.transact('Clear keyframes', d => {
                const pv = findClip(d.timelines[d.activeTimeline], owner.id)!.clip.properties.find(p => p.id === prop.id)!.params[paramId]
                delete pv.keyframes
                pv.value = structuredClone(value)
              })
              cleared++
            }
            note += ` ${cleared} parameters`
          } else {
            const def = copy.edit.paramDef(prop.type, op.paramId)
            if (!def) throw new Error(`Unknown parameter ${op.paramId}`)
            const keyframe = (t: Flicks, value: unknown, easing?: string) => {
              validateValue(def, value, options.fonts)
              if (def.animatable === false) throw new Error('Parameter is not animatable')
              if (t > clip.duration) throw new Error('Keyframe time exceeds clip duration')
              if (easing && !copy.registries.easings.get(easing)) throw new Error('Unknown easing')
              copy.edit.addKeyframe(owner.id, prop.id, op.paramId, t + shift, value, easing ? { id: easing } : undefined)
            }
            if (op.op === 'add_keyframe') keyframe(op.time, op.value, op.easing)
            else if (op.op === 'set_param') {
              validateValue(def, op.value, options.fonts)
              if (op.time !== undefined && op.time > clip.duration) throw new Error('Keyframe/parameter time exceeds clip duration')
              copy.edit.setParam(owner.id, prop.id, op.paramId, op.value, { at: (op.time ?? 0) + shift })
            } else if (op.op === 'add_keyframes') {
              for (const k of op.keys) keyframe(local(k.time, clip), k.value, k.easing)
              note += ` ${op.keys.length} keyframes`
            } else if (op.op === 'wiggle') {
              if (def.type !== 'number' && def.type !== 'angle' && def.type !== 'vec2') throw new Error('wiggle needs a number or vec2 parameter')
              const from = op.from === undefined ? 0 : local(op.from, clip)
              const to = op.to === undefined ? clip.duration : local(op.to, clip)
              if (to <= from) throw new Error('wiggle to must be after from')
              const step = FLICKS / op.frequency
              const n = Math.floor((to - from) / step)
              if (n > 2000) throw new Error('wiggle would add more than 2000 keyframes; lower frequency or shorten the range')
              if (op.easing && !copy.registries.easings.get(op.easing)) throw new Error('Unknown easing')
              const amp = Array.isArray(op.amplitude) ? op.amplitude : [op.amplitude, op.amplitude]
              const rnd = random(op.seed ?? 1)
              const clamp = (v: number) => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v))
              const pv = prop.params[op.paramId]
              // Sample the current animation first, then offset it; the ends stay on it so the wiggle blends in.
              const times = Array.from({ length: n + 1 }, (_, k) => Math.round(from + k * step))
              if (times.at(-1)! < to) times.push(to)
              const keys = times.map((t, k) => {
                const base = evaluateParam(copy.registries, def, pv, t + shift)
                const edge = k === 0 || k === times.length - 1
                const jitter = (a: number) => edge ? 0 : (rnd() * 2 - 1) * a
                const value = def.type === 'vec2' ? (base as [number, number]).map((v, i) => v + jitter(amp[i])) : clamp(Number(base) + jitter(amp[0]))
                return { t, value }
              })
              if (def.animatable === false) throw new Error('Parameter is not animatable')
              for (const k of keys) copy.edit.addKeyframe(owner.id, prop.id, op.paramId, k.t + shift, k.value, { id: op.easing ?? 'ease-in-out' })
              note += ` ${keys.length} keyframes`
            }
          }
        }
      }
      if ('ref' in op && op.ref && created) refs.set(op.ref, created)
      results.push(`${index + 1}. ${op.op}: ok${created ? ` ${ids.show(created, op.op === 'add_property' ? 'p' : 'c')}${'ref' in op && op.ref ? ` (${op.ref})` : ''}` : ''}${note}${retargeted ? `, on ${retargeted}` : ''}`)
    } catch (e) { throw new Error(`Operation ${index + 1} (${raw.op}): ${e instanceof Error ? e.message : e}. No edits applied.`) }
    finally {
      const reason = `operation ${index + 1} (${raw.op}${'clipId' in raw ? ` ${raw.clipId}` : ''})`
      for (const id of before) if (!gone.has(id) && !findClip(copy.timeline(), id)) gone.set(id, reason)
    }
  }
  for (const tr of copy.timeline().tracks) for (const clip of tr.clips) {
    if (clip.duration < MIN_CLIP || !Number.isSafeInteger(clip.start + clip.duration) || clip.sourceIn < 0) throw new Error('Result contains an invalid clip duration/range. No edits applied.')
    const media = clip.mediaId ? copy.project().media[clip.mediaId] : undefined
    if (!untouched.has(clip) && media?.meta.duration && copy.registries.mediaTypes.get(clip.type)?.timeBased) {
      const { lo, hi } = sourceSpan(clip, copy.edit.timeMap(clip))
      const slack = frameToFlicks(1, fps)
      if (lo < -slack || hi > media.meta.duration + slack) throw new Error(`Clip ${ids.show(clip.id, 'c')} would play past the ${lo < 0 ? 'start' : 'end'} of its source (speed too high for its duration?). No edits applied.`)
    }
  }
  if (options.dryRun) return results.join('\n') + '\nDry run: every operation is valid. Nothing was committed.'
  commit(app, copy.project(), ops.length === 1 ? ops[0].op.replaceAll('_', ' ') : `apply ${ops.length} edits`)
  return results.join('\n') + '\nOne undo step committed.'
}
