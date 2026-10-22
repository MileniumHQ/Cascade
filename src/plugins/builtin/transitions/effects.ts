import type { ParamDef, TransitionApplyContext, TransitionContribution } from '@core/plugin-api'

const select = (id: string, label: string, options: [string, string][], value = options[0][0]): ParamDef => ({ id, label, type: 'select', default: value, options: options.map(([value, label]) => ({ value, label })) })
const easing = select('easing', 'Easing', [['linear', 'Linear'], ['ease-in-out', 'Ease in-out'], ['ease-in', 'Ease in'], ['ease-out', 'Ease out']])
const direction = select('direction', 'Direction', [['left', '← Left'], ['right', '→ Right'], ['up', '↑ Up'], ['down', '↓ Down']])
export function transitionProgress(p: number, values: Record<string, unknown>): number {
  p = Math.max(0, Math.min(1, p))
  switch (values.easing) {
    case 'ease-in': return p * p
    case 'ease-out': return 1 - (1 - p) ** 2
    case 'ease-in-out': return p * p * (3 - 2 * p)
    default: return p
  }
}
const opacity = (v: number) => ({ style: { opacity: String(v) } })
const dissolve = (p: number, ctx: TransitionApplyContext) => ({ from: opacity(ctx.to ? 1 : 1 - p), to: opacity(p) })
const visual = (id: string, name: string, params: ParamDef[], apply: NonNullable<TransitionContribution['apply']>, description = name): TransitionContribution => ({
  id, name, description, icon: 'layers', kinds: ['visual'], defaultDuration: 0.5, params: [...params, easing],
  apply: (p, v, ctx) => apply(transitionProgress(p, v), v, ctx)
})
const shift = (p: number, v: Record<string, unknown>, ctx: TransitionApplyContext) => {
  const dir = v.direction
  return dir === 'up' || dir === 'down' ? `translateY(${ctx.u.y((dir === 'up' ? -1 : 1) * p)})` : `translateX(${ctx.u.x((dir === 'right' ? 1 : -1) * p)})`
}
const inset = (p: number, dir: unknown) => {
  const n = (1 - p) * 100
  return dir === 'right' ? `inset(0 ${n}% 0 0)` : dir === 'up' ? `inset(${n}% 0 0 0)` : dir === 'down' ? `inset(0 0 ${n}% 0)` : `inset(0 0 0 ${n}%)`
}

export const visualTransitions: TransitionContribution[] = [
  visual('cross-dissolve', 'Cross dissolve', [], (p, _v, ctx) => dissolve(p, ctx), 'Blend the incoming picture over the outgoing picture.'),
  visual('dip-to-color', 'Dip to color', [{ id: 'color', label: 'Color', type: 'color', default: '#000000' }], (p, v, ctx) => {
    // The overlay belongs to the outer frame layer, so it covers transformed/letterboxed content too.
    for (const layer of [ctx.elements.from, ctx.elements.to]) {
      if (!layer) continue
      let overlay = [...layer.querySelectorAll<HTMLElement>(':scope > .cs-dip-color')].find(el => el.dataset.csOwner === `tx:${ctx.id}`)
      if (!overlay) {
        overlay = ctx.elements.document.createElement('div')
        overlay.className = 'cs-dip-color'
        layer.appendChild(overlay)
      }
      overlay.dataset.csOwner = `tx:${ctx.id}`
      const amount = ctx.from && ctx.to ? 1 - Math.abs(2 * p - 1) : ctx.from ? p : 1 - p
      overlay.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:2147483647;background:${String(v.color)};opacity:${amount}`
    }
    return ctx.from && ctx.to ? { from: opacity(p < 0.5 ? 1 : 0), to: opacity(p >= 0.5 ? 1 : 0) } : { from: opacity(1), to: opacity(1) }
  }),
  visual('fade', 'Fade', [], (p, _v, ctx) => dissolve(p, ctx), 'Fade a clip to or from transparency.'),
  visual('wipe', 'Wipe', [direction, { id: 'softness', label: 'Softness', type: 'number', default: 0, min: 0, max: 1, unit: 'percent' }], (p, v, ctx) => {
    const softness = Math.max(0, Math.min(1, Number(v.softness) || 0))
    const mask = (amount: number): Record<string, string> => {
      if (!softness || amount === 0 || amount === 1) return { 'clip-path': inset(amount, v.direction) }
      const edge = (amount * (1 + softness) - softness / 2) * 100
      const angle = v.direction === 'right' ? 'to right' : v.direction === 'up' ? 'to top' : v.direction === 'down' ? 'to bottom' : 'to left'
      return { 'mask-image': `linear-gradient(${angle}, black ${edge - softness * 50}%, transparent ${edge + softness * 50}%)` }
    }
    return { from: { style: ctx.to ? {} : mask(1 - p) }, to: { style: mask(p) } }
  }),
  visual('push', 'Push', [direction], (p, v, ctx) => ({ from: { transform: [shift(p, v, ctx)] }, to: { transform: [shift(p - 1, v, ctx)] } })),
  visual('slide', 'Slide', [direction], (p, v, ctx) => ({ from: { transform: ctx.to ? [] : [shift(p, v, ctx)] }, to: { transform: [shift(p - 1, v, ctx)] } })),
  visual('zoom', 'Zoom', [select('direction', 'Direction', [['in', 'In'], ['out', 'Out']])], (p, v, ctx) => {
    const sign = v.direction === 'out' ? -1 : 1
    return { from: { ...opacity(ctx.to ? 1 : 1 - p), transform: [`scale(${1 + sign * p * 0.25})`] }, to: { ...opacity(p), transform: [`scale(${1 + sign * (p - 1) * 0.25})`] } }
  }),
  visual('blur-dissolve', 'Blur dissolve', [], (p, _v, ctx) => ({ from: { ...opacity(ctx.to ? 1 : 1 - p), filter: [`blur(${ctx.u.len(0.02 * p)})`] }, to: { ...opacity(p), filter: [`blur(${ctx.u.len(0.02 * (1 - p))})`] } }))
]

export function crossfadeGains(p: number, v: Record<string, unknown>): { from: number; to: number } {
  p = transitionProgress(p, v)
  if (v.curve === 'linear') return { from: 1 - p, to: p }
  if (v.curve === 'exponential') return { from: (1 - p) ** 2, to: p ** 2 }
  return { from: Math.cos(p * Math.PI / 2), to: Math.sin(p * Math.PI / 2) }
}
export const audioCrossfade: TransitionContribution = {
  id: 'audio-crossfade', name: 'Crossfade', description: 'Crossfade sound or fade a clip in or out.', icon: 'audio-lines', kinds: ['audio'],
  defaultDuration: 0.5, params: [select('curve', 'Curve', [['equal-power', 'Equal power'], ['linear', 'Linear'], ['exponential', 'Exponential']]), easing], gain: crossfadeGains
}
