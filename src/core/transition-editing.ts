import type { CascadeAPI } from './app'
import type { GestureOpts } from './editing'
import type { TransitionContribution } from './plugin-api'
import { findTransition, transitionWindow } from './transitions'
import { clipEnd, findClip, uid, type Id, type Timeline, type TransitionInstance } from '@shared/project'
import { FLICKS, frameDuration, type Flicks } from '@shared/time'

export interface AddTransitionOptions {
  type: string
  from?: Id
  to?: Id
  duration?: Flicks
  align?: TransitionInstance['align']
  params?: Record<string, unknown>
  linked?: boolean
}
export type TransitionPatch = Partial<Pick<TransitionInstance, 'type' | 'duration' | 'align' | 'params'>>

export class TransitionEditing {
  constructor(private app: CascadeAPI) {}

  add(opts: AddTransitionOptions, gesture?: GestureOpts): Id | null {
    const app = this.app, tl = app.timeline()
    const found = findClip(tl, opts.from ?? opts.to ?? '')
    const def = app.registries.transitions.get(opts.type)
    if (!found || found.track.locked || !def?.kinds.includes(found.track.kind) || ((!opts.from || !opts.to) && def.singleSided === false)) return null
    const tx: TransitionInstance = {
      id: uid('tx_'), type: opts.type, from: opts.from, to: opts.to,
      duration: Math.round(opts.duration ?? (def.defaultDuration ?? 0.5) * FLICKS), align: opts.align ?? 'center',
      params: { ...Object.fromEntries(def.params.map(p => [p.id, structuredClone(p.default)])), ...opts.params }
    }
    const w = transitionWindow(found.track, { ...tx, duration: Math.max(1, tx.duration || 1) })
    if (!w || Math.min(w.from?.duration ?? Infinity, w.to?.duration ?? Infinity) < frameDuration(app.fps())) return null
    const existing = found.track.transitions?.find(t => t.from === tx.from && t.to === tx.to)
    if (existing?.linkId && opts.linked !== false) {
      this.update(existing.id, { type: opts.type, ...(opts.duration !== undefined ? { duration: opts.duration } : {}), ...(opts.align ? { align: opts.align } : {}), ...(opts.params ? { params: opts.params } : {}) }, gesture)
      return existing.id
    }
    const twoSided = !!(opts.from && opts.to)
    const usable = (t: TransitionContribution | undefined): t is TransitionContribution => !!t?.kinds.includes('audio') && (twoSided || t.singleSided !== false)
    const audio = found.track.kind === 'visual' && opts.linked !== false
      ? [def.linked?.audio ? app.registries.transitions.get(def.linked.audio) : undefined, def].find(usable) ?? app.registries.transitions.all().find(usable)
      : undefined
    const partners: { trackId: Id; from?: Id; to?: Id }[] = []
    if (audio) for (const tr of tl.tracks) {
      if (tr.kind !== 'audio' || tr.locked) continue
      const from = w.from?.linkId ? tr.clips.find(c => c.linkId === w.from!.linkId && clipEnd(c) === clipEnd(w.from!)) : undefined
      const to = w.to?.linkId ? tr.clips.find(c => c.linkId === w.to!.linkId && c.start === w.to!.start) : undefined
      if ((w.from && !from) || (w.to && !to)) continue
      if (from && to && clipEnd(from) !== to.start) continue
      if (Math.min(from?.duration ?? Infinity, to?.duration ?? Infinity) < frameDuration(app.fps())) continue
      partners.push({ trackId: tr.id, from: from?.id, to: to?.id })
    }
    if (partners.length) tx.linkId = uid('txl_')
    const key = `transition:${tx.id}`
    if (gesture?.gesture === 'start') app.doc.beginGesture(key)
    app.doc.transact(`Add ${def.name}`, d => {
      const timeline = d.timelines[d.activeTimeline]
      const insert = (trackId: Id, transition: TransitionInstance) => {
        const track = timeline.tracks.find(t => t.id === trackId)!
        // Each edge has one transition. Remaining old partners become independent until replaced.
        const replaced = track.transitions?.filter(t => (transition.from && t.from === transition.from) || (transition.to && t.to === transition.to)) ?? []
        const links = new Set(replaced.map(t => t.linkId).filter(Boolean))
        for (const tr of timeline.tracks) if (tr.transitions) {
          tr.transitions = tr.transitions.filter(t => !replaced.some(r => r.id === t.id))
          for (const t of tr.transitions) if (t.linkId && links.has(t.linkId)) delete t.linkId
        }
        ;(track.transitions ??= []).push(transition)
      }
      insert(found.track.id, tx)
      for (const partner of partners) insert(partner.trackId, {
        ...tx, from: partner.from, to: partner.to, id: uid('tx_'), type: audio!.id,
        params: Object.fromEntries(audio!.params.map(p => [p.id, structuredClone(p.default)]))
      })
      // All paired sides must use the same duration, including short audio partners.
      if (tx.linkId) {
        const group = timeline.tracks.flatMap(tr => (tr.transitions ?? []).filter(t => t.linkId === tx.linkId).map(t => ({ tr, t })))
        const max = Math.min(...group.map(({ tr, t }) => {
          const w = transitionWindow(tr, { ...t, duration: 1 })!
          return Math.min(w.from?.duration ?? Infinity, w.to?.duration ?? Infinity)
        }))
        for (const { t } of group) t.duration = Math.min(max, Math.max(frameDuration(app.fps()), tx.duration || frameDuration(app.fps())))
      }
    }, gesture ? { coalesce: key } : {})
    if (gesture?.gesture === 'end') app.doc.endGesture()
    return findTransition(app.timeline(), tx.id) ? tx.id : null
  }

  update(id: Id, patch: TransitionPatch, opts?: GestureOpts): void {
    const app = this.app, tl = app.timeline(), found = findTransition(tl, id)
    if (!found || this.groupLocked(tl, found.transition)) return
    const def = patch.type ? app.registries.transitions.get(patch.type) : undefined
    if (patch.type && (!def?.kinds.includes(found.track.kind) || ((!found.transition.from || !found.transition.to) && def.singleSided === false))) return
    const key = `transition:${id}`
    if (opts?.gesture === 'start') app.doc.beginGesture(key)
    app.doc.transact('Edit transition', d => {
      const tl = d.timelines[d.activeTimeline]
      const self = findTransition(tl, id)!.transition
      const group = self.linkId ? tl.tracks.flatMap(tr => (tr.transitions ?? []).filter(t => t.linkId === self.linkId)) : [self]
      const max = Math.min(...group.map(t => {
        const tr = findTransition(tl, t.id)!.track
        const w = transitionWindow(tr, { ...t, duration: 1 })!
        return Math.min(w.from?.duration ?? Infinity, w.to?.duration ?? Infinity)
      }))
      const originalType = self.type
      for (const t of group) {
        if (patch.duration !== undefined && Number.isFinite(patch.duration)) t.duration = Math.min(max, Math.max(frameDuration(app.fps()), Math.round(patch.duration)))
        if (patch.align) t.align = patch.align
        if (t.id === id || t.type === originalType) {
          if (def && def.id !== t.type) {
            const previous = app.registries.transitions.get(t.type)
            // Only compatible params survive a type switch; unknown stored params survive ordinary edits.
            t.params = Object.fromEntries(def.params.map(p => [p.id, previous?.params.some(old => old.id === p.id && old.type === p.type) && t.params[p.id] !== undefined ? t.params[p.id] : structuredClone(p.default)]))
            t.type = def.id
          }
          if (patch.params) Object.assign(t.params, patch.params)
        }
      }
    }, { coalesce: key })
    if (opts?.gesture === 'end') app.doc.endGesture()
  }

  private groupLocked(tl: Timeline, tx: TransitionInstance): boolean {
    return tl.tracks.some(tr => tr.locked && tr.transitions?.some(t => t.id === tx.id || (tx.linkId && t.linkId === tx.linkId)))
  }

  remove(ids: Id[]): void {
    const app = this.app, tl = app.timeline()
    // A linked group is edited as a whole, so one locked member protects every member.
    const selected = new Set(ids.filter(id => { const f = findTransition(tl, id); return f && !this.groupLocked(tl, f.transition) }))
    if (!selected.size) return
    const links = new Set([...selected].map(id => findTransition(tl, id)?.transition.linkId).filter(Boolean))
    app.doc.transact('Delete transitions', d => {
      for (const tr of d.timelines[d.activeTimeline].tracks) if (tr.transitions) tr.transitions = tr.transitions.filter(t => !selected.has(t.id) && (!t.linkId || !links.has(t.linkId)))
    })
  }
}
