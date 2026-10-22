import type { Point } from './path'
/** Projective mapping of the unit content box to a transformed preview quad. */
export function quadMapping(c: Point[]): { toScreen(p: Point): Point; toLocal(p: Point): Point } | null {
  if (c.length !== 4) return null
  const [a, b, d, e] = c
  const dx1 = b.x - d.x, dx2 = e.x - d.x, dx3 = a.x - b.x + d.x - e.x
  const dy1 = b.y - d.y, dy2 = e.y - d.y, dy3 = a.y - b.y + d.y - e.y
  const det = dx1 * dy2 - dx2 * dy1
  const g = Math.abs(dx3) + Math.abs(dy3) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / det
  const h = Math.abs(dx3) + Math.abs(dy3) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / det
  const m = [b.x - a.x + g * b.x, e.x - a.x + h * e.x, a.x, b.y - a.y + g * b.y, e.y - a.y + h * e.y, a.y, g, h, 1]
  const [A, B, C, D, E, F, G, H, I] = m
  const inv = [E * I - F * H, C * H - B * I, B * F - C * E, F * G - D * I, A * I - C * G, C * D - A * F, D * H - E * G, B * G - A * H, A * E - B * D]
  const determinant = A * inv[0] + B * inv[3] + C * inv[6]
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null
  const apply = (v: number[], p: Point): Point => { const w = v[6] * p.x + v[7] * p.y + v[8]; return { x: (v[0] * p.x + v[1] * p.y + v[2]) / w, y: (v[3] * p.x + v[4] * p.y + v[5]) / w } }
  return { toScreen: p => apply(m, p), toLocal: p => apply(inv, p) }
}
