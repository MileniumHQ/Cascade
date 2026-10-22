import type { Registries } from '@core/app'
import type { PropertyOutput, TransitionApplyContext } from '@core/plugin-api'
import { transitionWindow } from '@core/transitions'
import { clipEnd } from '@shared/project'
import type { Clip, Id, Track, TransitionInstance } from '@shared/project'
import type { Flicks } from '@shared/time'

export const supportsTransition = (regs: Registries, track: Track, tx: TransitionInstance) => !!regs.transitions.get(tx.type)?.kinds.includes(track.kind)
type ResolvedTransition = { tx: TransitionInstance; window: NonNullable<ReturnType<typeof transitionWindow>> }
type ResolvedTrack = { registry: Registries['transitions']; revision: number; entries: ResolvedTransition[]; ranges: Map<Id, { start: Flicks; end: Flicks }>; byClip: Map<Id, ResolvedTransition[]> }
const trackCache = new WeakMap<Track, ResolvedTrack>()
function resolvedTrack(regs: Registries, track: Track): ResolvedTrack {
  const cached = Object.isFrozen(track) ? trackCache.get(track) : undefined
  if (cached?.registry === regs.transitions && cached.revision === regs.transitions.revision) return cached
  const result: ResolvedTrack = { registry: regs.transitions, revision: regs.transitions.revision, entries: [], ranges: new Map(track.clips.map(c => [c.id, { start: c.start, end: clipEnd(c) }])), byClip: new Map() }
  for (const tx of track.transitions ?? []) {
    if (!supportsTransition(regs, track, tx)) continue
    const window = transitionWindow(track, tx)
    if (!window) continue
    const entry = { tx, window }; result.entries.push(entry)
    for (const id of [tx.from, tx.to]) {
      if (!id) continue
      const range = result.ranges.get(id)!
      range.start = Math.max(0, Math.min(range.start, window.start)); range.end = Math.max(range.end, window.end)
      const list = result.byClip.get(id) ?? []; list.push(entry); result.byClip.set(id, list)
    }
  }
  if (Object.isFrozen(track)) trackCache.set(track, result)
  return result
}
export const clipRenderRange = (regs: Registries, track: Track, clip: Clip) => resolvedTrack(regs, track).ranges.get(clip.id) ?? { start: clip.start, end: clipEnd(clip) }
export const transitionValues = (regs: Registries, tx: TransitionInstance) => ({ ...Object.fromEntries((regs.transitions.get(tx.type)?.params ?? []).map(p => [p.id, p.default])), ...tx.params })

/** Multiplicative gain permits independent fades at opposite edges of a short clip. */
export function transitionGain(regs: Registries, track: Track, clip: Clip, t: Flicks): number {
  const range = clipRenderRange(regs, track, clip)
  if (t < range.start || t >= range.end) return 0
  let gain = 1
  for (const { tx, window: w } of resolvedTrack(regs, track).byClip.get(clip.id) ?? []) {
    if (t < w.start || t > w.end) continue
    const p = Math.max(0, Math.min(1, (t - w.start) / tx.duration))
    try {
      const g = regs.transitions.get(tx.type)!.gain?.(p, transitionValues(regs, tx)) ?? { from: Math.cos(p * Math.PI / 2), to: Math.sin(p * Math.PI / 2) }
      const value = tx.from === clip.id ? g.from : g.to
      gain *= Number.isFinite(value) ? Math.max(0, value) : 1
    } catch (e) { console.error(`[stage] transition gain ${tx.type} failed`, e) }
  }
  return gain
}

const previous = new WeakMap<HTMLElement, Set<string>>()
const outputStyle = (out: PropertyOutput, svgId: string): Record<string, string> => ({
  ...out.contentStyle, ...out.style,
  ...(out.transform ? { transform: out.transform.join(' ') } : {}),
  ...(out.filter || out.svgFilter ? { filter: [...(out.filter ?? []), ...(out.svgFilter ? [`url(#${svgId})`] : [])].join(' ') } : {}),
  ...(out.backdropFilter ? { 'backdrop-filter': out.backdropFilter.join(' ') } : {})
})

/** Compose generic outputs on frame-sized parents, leaving each clip's own properties intact. */
export function renderTransitionLayers(regs: Registries, track: Track, t: Flicks, layers: Map<Id, HTMLElement>, context: Omit<TransitionApplyContext, 'id' | 'from' | 'to' | 'duration' | 'elements'>): void {
  const styles = new Map<Id, Record<string, string>>()
  const owners = new Set<string>()
  const svgs = new Map<Id, string[]>()
  for (const { tx, window: w } of resolvedTrack(regs, track).entries) {
    const def = regs.transitions.get(tx.type)!
    if (t < w.start || t >= w.end || !def.apply) continue
    owners.add(`tx:${tx.id}`)
    try {
      const out = def.apply((t - w.start) / tx.duration, transitionValues(regs, tx), {
        ...context, id: tx.id, from: w.from, to: w.to, duration: tx.duration,
        elements: { from: tx.from ? layers.get(tx.from) : undefined, to: tx.to ? layers.get(tx.to) : undefined, document: contextDocument(layers) }
      })
      for (const [id, result, side] of [[tx.from, out?.from, 'from'], [tx.to, out?.to, 'to']] as const) {
        if (!id || !result || !layers.has(id)) continue
        const svgId = `txf_${tx.id}_${side}`
        if (result.svgFilter) {
          const list = svgs.get(id) ?? []
          list.push(`<filter id="${svgId}" color-interpolation-filters="sRGB" x="-50%" y="-50%" width="200%" height="200%">${result.svgFilter}</filter>`)
          svgs.set(id, list)
        }
        const next = outputStyle(result, svgId), prev = styles.get(id) ?? {}
        for (const [k, v] of Object.entries(next)) {
          if (k === 'opacity' && prev[k]) prev[k] = String(Number(prev[k]) * Number(v))
          else if (['transform', 'filter', 'backdrop-filter'].includes(k) && prev[k]) prev[k] += ` ${v}`
          else prev[k] = v
        }
        styles.set(id, prev)
      }
    } catch (e) { console.error(`[stage] transition ${tx.type} failed`, e) }
  }
  for (const [id, layer] of layers) {
    const next = styles.get(id) ?? {}, keys = previous.get(layer) ?? new Set<string>()
    for (const key of keys) if (!(key in next)) layer.style.removeProperty(key)
    for (const [key, value] of Object.entries(next)) layer.style.setProperty(key, value)
    previous.set(layer, new Set(Object.keys(next)))
    for (const el of layer.querySelectorAll<HTMLElement>('[data-cs-owner^="tx:"]')) if (!owners.has(el.dataset.csOwner!)) el.remove()
    let svg = layer.querySelector<SVGElement>(':scope > .cs-transition-defs')
    const markup = svgs.get(id)?.join('') ?? ''
    if (markup) {
      if (!svg) {
        svg = layer.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.classList.add('cs-transition-defs')
        svg.setAttribute('width', '0'); svg.setAttribute('height', '0')
        layer.appendChild(svg)
      }
      if (svg.innerHTML !== markup) svg.innerHTML = markup
    } else svg?.remove()
  }
}

function contextDocument(layers: Map<Id, HTMLElement>): Document {
  return layers.values().next().value!.ownerDocument
}
