import type { CascadeAPI } from '@core/app'
import { findMarker } from '@core/markers'
import { findTransition } from '@core/transitions'
import { clipEnd, findClip, type Id } from '@shared/project'
import type { ParamDef } from '@core/plugin-api'
import { CAPTION_STYLE_KIND, styleOverBase } from '../captions/styles'
import type { PropertyStyle } from '@core/property-style'
import type { Resolved } from './edits'

type PrimitiveName = 'add_transition' | 'update_transition' | 'remove_transition' | 'ripple_trim' | 'roll' | 'slip' | 'slide' | 'close_gap' | 'freeze_frame' | 'add_marker' | 'update_marker' | 'remove_marker' | 'nest' | 'break_apart' | 'create_timeline' | 'rename_timeline' | 'delete_timeline' | 'apply_preset'
type PrimitiveEdit = Extract<Resolved, { op: PrimitiveName }>
const names = new Set<string>(['add_transition', 'update_transition', 'remove_transition', 'ripple_trim', 'roll', 'slip', 'slide', 'close_gap', 'freeze_frame', 'add_marker', 'update_marker', 'remove_marker', 'nest', 'break_apart', 'create_timeline', 'rename_timeline', 'delete_timeline', 'apply_preset'])
export const isPrimitiveEdit = (op: Resolved): op is PrimitiveEdit => names.has(op.op)

/** Adapt agent coordinates and validate registry IDs before invoking public editing primitives. */
export function applyPrimitiveEdit(app: CascadeAPI, op: PrimitiveEdit, resolve: (id: string) => Id,
  editable: (id: string) => NonNullable<ReturnType<typeof findClip>>,
  validate: (def: ParamDef, value: unknown) => void): { created?: Id; prefix?: string; note?: string } {
  const timeline = (value: string) => {
    const tl = app.project().timelines[resolve(value)]
    if (!tl) throw new Error(`Unknown timeline ${value}; refresh project_get`)
    return tl
  }
  const marker = (value: string) => {
    const found = findMarker(app.timeline(), resolve(value))
    if (!found) throw new Error(`Unknown marker ${value}; refresh timeline_get`)
    if (found.locked) throw new Error(`Marker ${value} is on a locked track`)
    return found.marker.id
  }
  const kind = (id?: string) => { if (id && !app.registries.markerKinds.get(id)) throw new Error(`Unknown marker kind ${id}; inspect registry_list`) }
  const transition = (value: string) => {
    const found = findTransition(app.timeline(), resolve(value))
    if (!found) throw new Error(`Unknown transition ${value}; refresh timeline_get`)
    if (found.track.locked) throw new Error(`Transition ${value} is on a locked track`)
    // Paired updates/removal must not modify a locked partner track.
    if (found.transition.linkId && app.timeline().tracks.some(tr => tr.locked && tr.transitions?.some(tx => tx.linkId === found.transition.linkId))) throw new Error('Linked transition is on a locked track')
    return found
  }
  const transitionType = (id: string, trackKind: 'visual' | 'audio', single: boolean, params?: Record<string, unknown>) => {
    const def = app.registries.transitions.get(id)
    if (!def) throw new Error(`Unknown transition type ${id}; inspect registry_list`)
    if (!def.kinds.includes(trackKind)) throw new Error(`Transition ${id} does not support ${trackKind} tracks`)
    if (single && def.singleSided === false) throw new Error(`Transition ${id} requires both from and to`)
    for (const [key, value] of Object.entries(params ?? {})) {
      const param = def.params.find(p => p.id === key)
      if (!param) throw new Error(`Unknown transition parameter ${key}`)
      validate(param, value)
    }
  }
  const changed = (run: () => void, requested = true) => {
    const before = app.timeline()
    run()
    if (requested && JSON.stringify(before) === JSON.stringify(app.timeline())) throw new Error(`${op.op} cannot change this range; check adjacent clips, source handles and linked/locked tracks`)
  }
  switch (op.op) {
    case 'add_transition': {
      if (!op.from && !op.to) throw new Error('Give at least one of from or to')
      const edge = (value: string) => {
        const found = findClip(app.timeline(), resolve(value))
        if (!found) throw new Error(`Unknown clip ${value}; refresh timeline_get`)
        if (found.track.locked) throw new Error(`Clip ${value} is on a locked track`)
        return found
      }
      const from = op.from ? edge(op.from) : undefined, to = op.to ? edge(op.to) : undefined
      const track = (from ?? to)!.track
      if (from && to && from.track.id !== to.track.id) throw new Error('Transition clips must be on the same track')
      transitionType(op.type, track.kind, !from || !to, op.params)
      const existing = track.transitions?.find(tx => tx.from === from?.clip.id && tx.to === to?.clip.id)
      if (existing?.linkId) transition(existing.id)
      const created = app.edit.addTransition({ type: op.type, from: from?.clip.id, to: to?.clip.id, duration: op.duration, align: op.align, params: op.params })
      if (!created) throw new Error('Cannot add transition; clips must be adjacent and at least one frame long')
      return { created, prefix: 'x' }
    }
    case 'update_transition': {
      const { transition: tx, track } = transition(op.transitionId)
      if (op.type !== undefined || op.params !== undefined) transitionType(op.type ?? tx.type, track.kind, !tx.from || !tx.to, op.params)
      const { op: _, transitionId, ...patch } = op
      if (!Object.keys(patch).length) throw new Error('Give type, duration, align or params')
      app.edit.updateTransition(tx.id, patch)
      break
    }
    case 'remove_transition': app.edit.removeTransitions([transition(op.transitionId).transition.id]); break
    case 'add_marker': {
      kind(op.kind)
      const clipId = op.clipId ? editable(op.clipId).clip.id : undefined
      const created = app.edit.addMarker(op.time, op.name, { kind: op.kind, color: op.color, note: op.note, duration: op.duration, clipId })
      if (!created) throw new Error('Cannot add marker')
      return { created, prefix: 'k' }
    }
    case 'update_marker': {
      const id = marker(op.markerId)
      kind(op.kind)
      const { op: _, markerId, time, ...patch } = op
      if (time === undefined && !Object.keys(patch).length) throw new Error('Give marker fields or time')
      if (Object.keys(patch).length) app.edit.updateMarker(id, patch)
      if (time !== undefined) app.edit.moveMarker(id, time)
      break
    }
    case 'remove_marker': app.edit.removeMarkers([marker(op.markerId)]); break
    case 'create_timeline': return { created: app.edit.createTimeline({ name: op.name }), prefix: 'l' }
    case 'rename_timeline': app.edit.renameTimeline(timeline(op.timelineId).id, op.name); break
    case 'delete_timeline': {
      const id = timeline(op.timelineId).id, reason = app.edit.deleteTimelineReason(id)
      if (reason) throw new Error(reason)
      if (!app.edit.deleteTimeline(id)) throw new Error('Cannot delete timeline')
      break
    }
    case 'nest': {
      const ids = op.clipIds.map(id => editable(id).clip.id)
      const reason = app.edit.nestClipsReason(ids)
      if (reason) throw new Error(reason)
      const type = app.registries.mediaTypes.get(op.mediaType)
      if (!type || type.track !== 'visual') throw new Error(`Unknown or incompatible composition media type ${op.mediaType}`)
      const created = app.edit.nestClips(ids, { mediaType: type.id, name: op.name })
      if (!created) throw new Error('Cannot nest these clips')
      return { created, prefix: 'c' }
    }
    case 'break_apart': {
      const id = editable(op.clipId).clip.id, reason = app.edit.breakApartClipReason(id)
      if (reason) throw new Error(reason)
      const clips = app.edit.breakApartClip(id)
      if (!clips) throw new Error('Cannot break apart this clip')
      return { note: ` ${clips.length} clips restored` }
    }
    case 'apply_preset': {
      const preset = app.registries.presets.get(op.presetId)
      if (!preset) throw new Error(`Unknown preset ${op.presetId}; inspect registry_list`)
      // Caption styles are currently the registered PropertyStyle kind; reuse its UI adapter.
      if (preset.kind !== CAPTION_STYLE_KIND) throw new Error(`Preset kind ${preset.kind} is not a property style`)
      const ids = op.clipIds.map(id => editable(id).clip.id)
      const count = app.edit.applyStyle(ids, styleOverBase(preset.value as PropertyStyle), `Style: ${preset.name}`)
      return { note: ` ${count} clips styled` }
    }
    case 'close_gap': {
      const track = app.timeline().tracks.find(t => t.id === resolve(op.trackId))
      if (!track || track.locked) throw new Error(`Unknown/locked track ${op.trackId}`)
      changed(() => app.edit.closeGap(track.id, op.time))
      break
    }
    default: {
      const { clip } = editable(op.clipId)
      if (op.op === 'freeze_frame') {
        const created = app.edit.freezeFrame(clip.id, op.time, op.duration)
        if (!created) throw new Error('Cannot freeze frame; time must be inside a visual clip with a time-remap property and unlocked linked tracks')
        return { created, prefix: 'c' }
      }
      if (op.op === 'ripple_trim') {
        if (op.edge === 'start' ? op.time >= clipEnd(clip) : op.time <= clip.start) throw new Error('Ripple trim would remove entire clip')
        changed(() => app.edit.rippleTrim(clip.id, op.edge, op.time), op.time !== (op.edge === 'start' ? clip.start : clipEnd(clip)))
      } else if (op.op === 'roll') {
        const delta = op.time - (op.edge === 'start' ? clip.start : clipEnd(clip))
        changed(() => app.edit.rollEdit(clip.id, op.edge, delta), delta !== 0)
      } else if (op.op === 'slip') changed(() => app.edit.slipClip(clip.id, op.delta), op.delta !== 0)
      else changed(() => app.edit.slideClip(clip.id, op.delta), op.delta !== 0)
    }
  }
  return {}
}
