import { uid, type Id, type Track, type TransitionInstance } from '@shared/project'

/** Retain transitions only when every attached endpoint belongs to the copied set. */
export function copiedTransitions(track: Track, ids: ReadonlySet<Id>): TransitionInstance[] {
  return (track.transitions ?? []).filter(t => (t.from || t.to) && (!t.from || ids.has(t.from)) && (!t.to || ids.has(t.to)))
}
export function remapTransitions(transitions: readonly TransitionInstance[], clips: ReadonlyMap<Id, Id>, links: Map<Id, Id>): TransitionInstance[] {
  return transitions.map(t => {
    const copy = structuredClone(t)
    copy.id = uid('tx_')
    if (copy.from) copy.from = clips.get(copy.from)
    if (copy.to) copy.to = clips.get(copy.to)
    if (copy.linkId) {
      if (!links.has(copy.linkId)) links.set(copy.linkId, uid('ln_'))
      copy.linkId = links.get(copy.linkId)
    }
    return copy
  })
}
