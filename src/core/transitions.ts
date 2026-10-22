/** Generic transition geometry and integrity. No plugin/type ids belong here. */
import { clipEnd, type Clip, type Id, type Project, type Timeline, type Track, type TransitionInstance } from '@shared/project'
import { frameDuration, type Flicks } from '@shared/time'

export interface TransitionEdge { from?: Id; to?: Id; time: Flicks }
export interface TransitionWindow { start: Flicks; end: Flicks; from?: Clip; to?: Clip }

export function transitionWindow(track: Track, tx: TransitionInstance): TransitionWindow | null {
  const from = tx.from ? track.clips.find(c => c.id === tx.from) : undefined
  const to = tx.to ? track.clips.find(c => c.id === tx.to) : undefined
  if ((!from && !to) || (tx.from && !from) || (tx.to && !to) || tx.from === tx.to || !(tx.duration > 0)) return null
  if (from && to && clipEnd(from) !== to.start) return null
  const cut = to?.start ?? clipEnd(from!)
  const start = !from ? cut : !to ? cut - tx.duration : tx.align === 'end' ? cut - tx.duration : tx.align === 'start' ? cut : cut - Math.floor(tx.duration / 2)
  return { start, end: start + tx.duration, from, to }
}

/** Cuts win ties with isolated edges. Can request cuts only for the default-transition commands. */
export function nearestTransitionEdge(track: Track, time: Flicks, cutsOnly = false): TransitionEdge | null {
  const edges: TransitionEdge[] = []
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i], prev = track.clips[i - 1], next = track.clips[i + 1]
    if (prev && clipEnd(prev) === c.start) edges.push({ from: prev.id, to: c.id, time: c.start })
    else if (!cutsOnly) edges.push({ to: c.id, time: c.start })
    if (!cutsOnly && (!next || clipEnd(c) !== next.start)) edges.push({ from: c.id, time: clipEnd(c) })
  }
  return edges.reduce<TransitionEdge | null>((best, edge) => {
    const distance = Math.abs(edge.time - time), previous = best ? Math.abs(best.time - time) : Infinity
    return distance < previous || distance === previous && edge.from && edge.to && !(best?.from && best?.to) ? edge : best
  }, null)
}

export function findTransition(timeline: Timeline, id: Id): { track: Track; transition: TransitionInstance } | null {
  for (const track of timeline.tracks) {
    const transition = track.transitions?.find(t => t.id === id)
    if (transition) return { track, transition }
  }
  return null
}

/** Pure: preserves unknown type ids/params and stable object identity when already valid. */
export function normalizeTransitions(track: Track, frame: Flicks): TransitionInstance[] | undefined {
  if (!track.transitions) return undefined
  const edges = new Set<string>()
  const out: TransitionInstance[] = []
  for (const tx of track.transitions) {
    const w = transitionWindow(track, tx)
    // NaN/zero/negative duration is repaired too; temporarily use one frame for geometry validation.
    const valid = w ?? transitionWindow(track, { ...tx, duration: frame })
    if (!valid) continue
    const max = Math.min(valid.from?.duration ?? Infinity, valid.to?.duration ?? Infinity)
    if (max < frame) continue
    const keys = [tx.from && `end:${tx.from}`, tx.to && `start:${tx.to}`].filter((k): k is string => !!k)
    if (keys.some(k => edges.has(k))) continue
    keys.forEach(k => edges.add(k))
    const duration = Math.min(max, Math.max(frame, Number.isFinite(tx.duration) ? Math.round(tx.duration) : frame))
    const align = ['center', 'start', 'end'].includes(tx.align) ? tx.align : 'center'
    out.push(duration === tx.duration && align === tx.align ? tx : { ...tx, duration, align })
  }
  return out.length === track.transitions.length && out.every((tx, i) => tx === track.transitions![i]) ? track.transitions : out
}

/** One transaction-final normalization pass, shared by all timeline edits and plugin transactions. */
export function normalizeProjectTransitions(project: Project): void {
  const frame = frameDuration(project.settings.fps)
  for (const tl of Object.values(project.timelines)) for (const track of tl.tracks) {
    const next = normalizeTransitions(track, frame)
    if (next !== track.transitions) track.transitions = next
  }
  // A linked pair has one window, even if only one partner's clip was shortened.
  for (const tl of Object.values(project.timelines)) {
    const groups = new Map<Id, TransitionInstance[]>()
    for (const tr of tl.tracks) for (const tx of tr.transitions ?? []) if (tx.linkId) {
      const group = groups.get(tx.linkId) ?? []; group.push(tx); groups.set(tx.linkId, group)
    }
    for (const group of groups.values()) {
      const duration = Math.min(...group.map(tx => tx.duration))
      for (const tx of group) if (tx.duration !== duration) tx.duration = duration
    }
  }
}

/** A split preserves the original end edge on its new right-hand piece, including overwrite splits. */
export function transferTransitionEnd(track: Track, from: Id, right: Id): void {
  for (const tx of track.transitions ?? []) if (tx.from === from) tx.from = right
}

/** Active clip extent. Missing/unsupported contributions are ignored by the caller's predicate. */
export function transitionClipRange(track: Track, clip: Clip, accepts: (tx: TransitionInstance) => boolean = () => true): { start: Flicks; end: Flicks } {
  let start = clip.start, end = clipEnd(clip)
  for (const tx of track.transitions ?? []) {
    if ((tx.from !== clip.id && tx.to !== clip.id) || !accepts(tx)) continue
    const w = transitionWindow(track, tx)
    if (w) { start = Math.min(start, w.start); end = Math.max(end, w.end) }
  }
  return { start: Math.max(0, start), end }
}
