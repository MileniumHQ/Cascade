/** Generic SVG alpha-layer composition. No knowledge of any property or media type. */
import type { MaskLayer, MaskBox } from '@core/plugin-api'

/** SVG IDs belong to their layer, even when several instances use the same fragment. */
export function namespaceMaskSvg(svg: string, prefix: string): string {
  const ids = new Map<string, string>()
  svg = svg.replace(/(\sid\s*=\s*["'])([^"']+)(["'])/g, (_all, a, id, b) => { const scoped = `${prefix}${id}`; ids.set(id, scoped); return a + scoped + b })
  return svg.replace(/url\(\s*(["']?)#([^)'"\s]+)\1\s*\)/g, (all, _q, id) => ids.has(id) ? `url(#${ids.get(id)})` : all)
    .replace(/(\s(?:xlink:)?href\s*=\s*["'])#([^"']+)(["'])/g, (all, a, id, b) => ids.has(id) ? `${a}#${ids.get(id)}${b}` : all)
}
const RECT = '<rect width="1" height="1" fill="white"/>'
/** Porter–Duff alpha semantics, shared by plugin documentation/tests. */
export function compositeMaskAlpha(a: number, b: number, mode: MaskLayer['mode']): number {
  switch (mode) {
    case 'subtract': return a * (1 - b)
    case 'intersect': return a * b
    case 'difference': return a * (1 - b) + b * (1 - a)
    default: return b + a * (1 - b)
  }
}
/** Each fragment paints alpha in a 0..1 content viewBox. IDs are local to the data URL. */
export function composeMaskSvg(layers: Pick<MaskLayer, 'svg' | 'mode'>[], box: MaskBox): string {
  const resolved = layers.flatMap(layer => {
    try { return [{ svg: typeof layer.svg === 'function' ? layer.svg(box) : layer.svg, mode: layer.mode }] }
    catch (error) { console.warn('[stage] mask layer skipped', error); return [] }
  })
  if (!resolved.length) return ''
  let defs = '<filter id="black" x="0" y="0" width="1" height="1" filterUnits="userSpaceOnUse"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter>'
  const mask = (id: string, source: string) => {
    defs += `<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" style="mask-type:alpha">${source}</mask>`
    // Black source over white is the exact complement of source alpha, including soft edges.
    defs += `<mask id="${id}inv" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" style="mask-type:luminance">${RECT}<g filter="url(#black)">${source}</g></mask>`
  }
  const use = (id: string, m?: string) => `<use href="#${id}"${m ? ` mask="url(#${m})"` : ''}/>`
  resolved.forEach((layer, i) => {
    defs += `<g id="s${i}">${namespaceMaskSvg(layer.svg, `layer${i}-`)}</g>`
    mask(`m${i}`, use(`s${i}`))
    const prev = `r${i - 1}`, source = `s${i}`, normal = `m${i}`, inverse = `${normal}inv`
    let result: string
    if (i === 0) result = layer.mode === 'subtract' ? `<g mask="url(#${inverse})">${RECT}</g>` : use(source)
    else switch (layer.mode) {
      case 'subtract': result = use(prev, inverse); break
      case 'intersect': result = use(prev, normal); break
      case 'difference':
        mask(`previous${i}`, use(prev))
        // Exclusive alpha terms sum to <= 1; plus-lighter preserves that exact sum.
        defs += `<g id="a${i}">${use(prev, inverse)}</g><g id="b${i}">${use(source, `previous${i}inv`)}</g>`
        // Isolate the group so blending cannot escape into surrounding mask layers.
        result = `<g style="isolation:isolate">${use(`a${i}`)}<g style="mix-blend-mode:plus-lighter">${use(`b${i}`)}</g></g>`
        break
      default: result = use(prev) + use(source)
    }
    defs += `<g id="r${i}">${result}</g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none"><defs>${defs}</defs>${use(`r${resolved.length - 1}`)}</svg>`
}
const previous = new WeakMap<HTMLElement, string>()
function clearMasks(wrapper: HTMLElement) {
  if (!previous.has(wrapper)) return
  for (const key of ['mask-image', 'mask-size', 'mask-repeat', 'mask-mode']) wrapper.style.removeProperty(key)
  previous.delete(wrapper)
}
export function applyMasks(wrapper: HTMLElement, layers: MaskLayer[], frame: MaskBox['frame']): void {
  if (!layers.length) { clearMasks(wrapper); return }
  const computed = wrapper.ownerDocument.defaultView?.getComputedStyle(wrapper)
  const width = parseFloat(computed?.width ?? '') || wrapper.offsetWidth
  const height = parseFloat(computed?.height ?? '') || wrapper.offsetHeight
  // Hidden preroll/postroll clips have no layout box; resolve once they become visible.
  if (!(width > 0 && height > 0)) return
  const svg = composeMaskSvg(layers, { width, height, frame })
  if (!svg) { clearMasks(wrapper); return }
  if (previous.get(wrapper) === svg) return
  previous.set(wrapper, svg)
  wrapper.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  wrapper.style.maskSize = '100% 100%'; wrapper.style.maskRepeat = 'no-repeat'; wrapper.style.maskMode = 'alpha'
}
