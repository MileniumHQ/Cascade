import { CascadeApp, type CascadeAPI } from '@core/app'
import { clipEnd, findClip, type Project, type Clip } from '@shared/project'
import { MIN_CLIP } from '@core/timeline-ops'
import type { TimeMap } from '@core/time-remap'
import { ANCHOR, editSchema, type Edit } from '../../../main/mcp/catalog'
import type { ParamDef } from '@core/plugin-api'
import { FLICKS } from '@shared/time'
import { buildIndex, type Analyses } from './transcript'

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
type Resolved = Edit extends infer E ? E extends unknown ? { [K in keyof E]: K extends 'start' | 'end' | 'time' ? Extract<E[K], number | undefined> : E[K] } : never : never

/** Timeline flicks for a transcript anchor (w12, w12.end, s3.start, w12.end+80ms, s3.end+2f) in `project`. */
export function resolveAnchor(project: Project, analyses: Analyses | undefined, ids: Ids, value: string, timeMap?: (clip: Clip) => TimeMap): number {
  const match = ANCHOR.exec(value)
  if (!match) throw new Error(`Invalid anchor ${value}`)
  const [, id, edge, sign, amount, unit] = match
  const key = ids.resolve(id)
  const index = buildIndex(project, analyses ?? new Map(), timeMap)
  const item = index.sentences.find(x => x.key === key) ?? index.words.find(x => x.key === key)
  if (!item) throw new Error(`${id} is not on the timeline (cut already, or not an id from transcript_get/transcript_search)`)
  const fps = project.settings.fps
  const per = unit === 'ms' ? FLICKS / 1000 : unit === 'f' ? FLICKS * fps.den / fps.num : FLICKS
  const offset = amount ? Math.round(Number(amount) * per) * (sign === '-' ? -1 : 1) : 0
  return Math.max(0, (edge === 'end' ? item.end : item.start) + offset)
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
function validateValue(def: ParamDef, value: unknown) {
  if (['number', 'angle'].includes(def.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) throw new Error(`Invalid ${def.id}; expected finite number in ${def.min ?? '-∞'}..${def.max ?? '∞'}`)
  } else if (def.type === 'vec2') {
    if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${def.id} needs two finite numbers (frame fractions for spatial units)`)
  } else if (def.type === 'toggle' && typeof value !== 'boolean') throw new Error(`${def.id} needs a boolean`)
  else if (['text', 'font', 'color', 'select'].includes(def.type) && typeof value !== 'string') throw new Error(`${def.id} needs a string`)
  if (def.options && !def.options.some(o => o.value === value)) throw new Error(`Unknown ${def.id} option; inspect registry_list`)
}
export function applyEdits(app: CascadeAPI, input: unknown, ids: Ids, analyses?: Analyses) {
  const ops = editSchema.array().min(1).max(200).parse((input as { ops: unknown }).ops)
  const copy = staging(app)
  const refs = new Map<string, string>()
  const resolve = (v: string) => refs.get(v) ?? ids.resolve(v)
  const editable = (id: string) => {
    const f = findClip(copy.timeline(), resolve(id))
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
  let retargeted = ''
  const resolveTimes = (raw: Edit): Resolved => {
    retargeted = ''
    const op = { ...raw } as Record<string, unknown>
    for (const key of ['start', 'end', 'time'] as const) if (typeof op[key] === 'string') op[key] = anchor(op[key] as string)
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
  const results: string[] = []
  for (const [index, raw] of ops.entries()) {
    try {
      const op = resolveTimes(raw)
      let created: string | null | undefined
      if ('ref' in op && op.ref && (refs.has(op.ref) || ids.resolve(op.ref) !== op.ref)) throw new Error(`Duplicate/reserved ref ${op.ref}`)
      if (op.op === 'add_clip' || op.op === 'add_text') {
        let clip: Clip | null
        if (op.op === 'add_clip') {
          const media = copy.project().media[resolve(op.mediaId)]
          if (!media) throw new Error(`Unknown media ${op.mediaId}`)
          clip = copy.edit.buildClip(media, op.start)
          if (!clip) throw new Error('Media type unavailable; inspect registry_list')
          clip.sourceIn = op.sourceIn ?? 0
          if (media.meta.duration && copy.registries.mediaTypes.get(media.type)?.timeBased && clip.sourceIn + op.duration > media.meta.duration) throw new Error('Clip exceeds source duration')
        } else {
          const mediaId = copy.edit.addGenerated('text')
          if (!mediaId) throw new Error('Text generator unavailable')
          clip = copy.edit.buildClip(copy.project().media[mediaId], op.start)
          if (!clip) throw new Error('Text media type unavailable')
          const text = clip.properties.find(p => p.type === 'text')
          if (!text) throw new Error('Text property unavailable')
          text.params.text = { value: op.text }; clip.name = op.text.slice(0, 80) || 'Text'
        }
        clip.start = op.start; clip.duration = op.duration
        created = copy.edit.insertClip(clip, track(op.trackId, clip.type))
        // Match the UI's linked audio behavior, using the requested trimmed source range.
        const media = clip.mediaId ? copy.project().media[clip.mediaId] : undefined
        const audioType = copy.registries.mediaTypes.get(clip.type)?.linkedAudioType
        if (media?.meta.hasAudio && audioType && created) {
          const audio = copy.edit.buildClip(media, op.start, audioType)
          if (audio) {
            const linkId = `agent_${created}`
            copy.doc.transact('Link audio', d => { findClip(d.timelines[d.activeTimeline], created!)!.clip.linkId = linkId })
            audio.start = op.start; audio.duration = op.duration; audio.sourceIn = clip.sourceIn; audio.linkId = linkId
            const audioId = copy.edit.insertClip(audio, track(undefined, audioType))
            if (audioId) copy.doc.transact('Link audio', d => { findClip(d.timelines[d.activeTimeline], audioId)!.clip.linkId = linkId })
          }
        }
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
        else if (op.op === 'add_property') {
          const def = copy.registries.properties.get(op.type)
          if (!def || !copy.edit.propertyApplies(def, clip)) throw new Error(`Property ${op.type} unavailable or incompatible`)
          if (!def.stackable && clip.properties.some(p => p.type === op.type)) throw new Error('Property already exists')
          created = copy.edit.addProperty(clip.id, op.type)
        } else {
          const prop = clip.properties.find(p => p.id === resolve(op.propertyId) || p.type === op.propertyId)
          if (!prop) throw new Error(`Unknown property ${op.propertyId}`)
          if (op.op === 'remove_property') copy.edit.removeProperty(clip.id, prop.id)
          else {
            const def = copy.edit.paramDef(prop.type, op.paramId)
            if (!def) throw new Error(`Unknown parameter ${op.paramId}`)
            validateValue(def, op.value)
            if (op.time !== undefined && op.time > clip.duration) throw new Error('Keyframe/parameter time exceeds clip duration')
            if (op.op === 'add_keyframe') {
              if (def.animatable === false) throw new Error('Parameter is not animatable')
              if (op.easing && !copy.registries.easings.get(op.easing)) throw new Error('Unknown easing')
              copy.edit.addKeyframe(clip.id, prop.id, op.paramId, op.time, op.value, op.easing ? { id: op.easing } : undefined)
            } else copy.edit.setParam(clip.id, prop.id, op.paramId, op.value, { at: op.time ?? 0 })
          }
        }
      }
      if ('ref' in op && op.ref && created) refs.set(op.ref, created)
      results.push(`${index + 1}. ${op.op}: ok${created ? ` ${ids.show(created, op.op === 'add_property' ? 'p' : 'c')}${'ref' in op && op.ref ? ` (${op.ref})` : ''}` : ''}${retargeted ? `, on ${retargeted}` : ''}`)
    } catch (e) { throw new Error(`Operation ${index + 1} (${raw.op}): ${e instanceof Error ? e.message : e}. No edits applied.`) }
  }
  for (const tr of copy.timeline().tracks) for (const clip of tr.clips) {
    if (clip.duration < MIN_CLIP || !Number.isSafeInteger(clip.start + clip.duration) || clip.sourceIn < 0) throw new Error('Result contains an invalid clip duration/range. No edits applied.')
  }
  commit(app, copy.project(), ops.length === 1 ? ops[0].op.replaceAll('_', ' ') : `apply ${ops.length} edits`)
  return results.join('\n') + '\nOne undo step committed.'
}
