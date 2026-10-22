import type { MaskBox, MaskLayer } from '@core/plugin-api'
import { coercePath, pathToSvg } from '@shared/path'
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const n = (v: number) => +v.toFixed(9)
/** Frame-height lengths become content-space radii independently on each axis. */
export function maskRadii(length: number, box: MaskBox): [number, number] {
  return [length * box.frame.height / Math.max(1e-6, box.width), length * box.frame.height / Math.max(1e-6, box.height)]
}
/** Scoped IDs are passed explicitly so stackable instances never share a filter. */
export function maskFragment(values: Record<string, unknown>, box: MaskBox, id: string): string {
  const d = pathToSvg(coercePath(values.shape)), feather = Math.max(0, finite(values.feather)), expansion = finite(values.expansion)
  const [fx, fy] = maskRadii(feather, box), [ex, ey] = maskRadii(Math.abs(expansion), box)
  const extentX = Math.max(1, fx * 4 + ex), extentY = Math.max(1, fy * 4 + ey)
  const primitives = (expansion ? `<feMorphology operator="${expansion > 0 ? 'dilate' : 'erode'}" radius="${n(ex)} ${n(ey)}"/>` : '') + (feather ? `<feGaussianBlur stdDeviation="${n(fx)} ${n(fy)}"/>` : '') + (values.invert ? '<feComponentTransfer><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>' : '')
  const filter = primitives ? `<defs><filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${-extentX}" y="${-extentY}" width="${1 + 2 * extentX}" height="${1 + 2 * extentY}" color-interpolation-filters="sRGB">${primitives}</filter></defs>` : ''
  return `${filter}<g opacity="${clamp(finite(values.opacity))}"><path d="${d}" fill="white" fill-rule="evenodd"${primitives ? ` filter="url(#${id})"` : ''}/></g>`
}
export function maskMode(value: unknown): MaskLayer['mode'] {
  return value === 'subtract' || value === 'intersect' || value === 'difference' ? value : 'add'
}
