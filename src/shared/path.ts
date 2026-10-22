/** Cubic Bézier geometry. Coordinates are fractions of the untransformed content box. */
export interface PathPoint { x: number; y: number; in?: [number, number]; out?: [number, number] }
export interface PathValue { closed: boolean; points: PathPoint[] }
export interface Point { x: number; y: number }
export type Cubic = [Point, Point, Point, Point]
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const relative = (p: Point, origin: Point): [number, number] => [p.x - origin.x, p.y - origin.y]
export const clonePath = (p: PathValue): PathValue => structuredClone(p)
export function coercePath(value: unknown, fallback: PathValue = { closed: false, points: [] }): PathValue {
  const v = value as PathValue | null
  if (!v || !Array.isArray(v.points) || !v.points.every(p => p && finite(p.x) && finite(p.y))) return clonePath(fallback)
  return { closed: !!v.closed, points: v.points.map(p => {
    const q: PathPoint = { x: p.x, y: p.y }
    for (const k of ['in', 'out'] as const) if (Array.isArray(p[k]) && p[k]!.length === 2 && p[k]!.every(finite)) q[k] = [...p[k]!]
    return q
  }) }
}
export function interpolatePath(a: PathValue, b: PathValue, t: number): PathValue {
  a = coercePath(a); b = coercePath(b)
  if (a.closed !== b.closed || a.points.length !== b.points.length) return t >= 1 ? b : a
  return { closed: a.closed, points: a.points.map((p, i) => {
    const q = b.points[i]
    const v: PathPoint = mix(p, q, t)
    for (const k of ['in', 'out'] as const) if (p[k] || q[k]) v[k] = [0, 1].map(j => (p[k]?.[j] ?? 0) + ((q[k]?.[j] ?? 0) - (p[k]?.[j] ?? 0)) * t) as [number, number]
    return v
  }) }
}
export function rectanglePath(x = 0.2, y = 0.2, width = 0.6, height = 0.6): PathValue {
  return { closed: true, points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] }
}
export function ellipsePath(cx = 0.5, cy = 0.5, rx = 0.3, ry = 0.3): PathValue {
  const k = 4 * (Math.sqrt(2) - 1) / 3
  return { closed: true, points: [
    { x: cx, y: cy - ry, in: [-rx * k, 0], out: [rx * k, 0] },
    { x: cx + rx, y: cy, in: [0, -ry * k], out: [0, ry * k] },
    { x: cx, y: cy + ry, in: [rx * k, 0], out: [-rx * k, 0] },
    { x: cx - rx, y: cy, in: [0, ry * k], out: [0, -ry * k] }
  ] }
}
export const segmentCount = (p: PathValue) => Math.max(0, p.points.length - (p.closed ? 0 : 1))
export function pathSegment(path: PathValue, index: number): Cubic {
  if (index < 0 || index >= segmentCount(path)) throw new RangeError('Path segment out of range')
  const a = path.points[index], b = path.points[(index + 1) % path.points.length]
  return [a, { x: a.x + (a.out?.[0] ?? 0), y: a.y + (a.out?.[1] ?? 0) }, { x: b.x + (b.in?.[0] ?? 0), y: b.y + (b.in?.[1] ?? 0) }, b]
}
export function cubicPoint(c: Cubic, t: number): Point {
  const a = mix(c[0], c[1], t), b = mix(c[1], c[2], t), d = mix(c[2], c[3], t)
  return mix(mix(a, b, t), mix(b, d, t), t)
}
/** de Casteljau subdivision preserves the original curve exactly, including closing segments. */
export function insertPathPoint(path: PathValue, index: number, t: number): PathValue {
  const c = pathSegment(path, index), p = clonePath(path)
  t = Math.max(0, Math.min(1, t))
  const a = mix(c[0], c[1], t), b = mix(c[1], c[2], t), d = mix(c[2], c[3], t)
  const e = mix(a, b, t), f = mix(b, d, t), q = mix(e, f, t)
  p.points[index].out = relative(a, c[0])
  p.points[(index + 1) % p.points.length].in = relative(d, c[3])
  p.points.splice(index + 1, 0, { ...q, in: relative(e, q), out: relative(f, q) })
  return p
}
export function pathToSvg(path: PathValue, map: (p: Point) => Point = p => p): string {
  if (!path.points.length) return ''
  const pair = (p: Point) => { const q = map(p); return `${+q.x.toFixed(9)} ${+q.y.toFixed(9)}` }
  let s = `M ${pair(path.points[0])}`
  for (let i = 0; i < segmentCount(path); i++) {
    const c = pathSegment(path, i)
    s += ` C ${pair(c[1])} ${pair(c[2])} ${pair(c[3])}`
  }
  return s + (path.closed ? ' Z' : '')
}
/** Parse one SVG subpath containing M/L/H/V/C/Z (absolute or relative). Unsupported commands throw. */
export function pathFromSvg(data: string): PathValue {
  const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []
  if (data.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, '')) throw new Error('Invalid SVG path')
  const path: PathValue = { closed: false, points: [] }
  let i = 0, cmd = '', current: Point = { x: 0, y: 0 }
  const number = () => { const n = Number(tokens[i++]); if (!Number.isFinite(n)) throw new Error('Invalid SVG coordinate'); return n }
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++]
    const upper = cmd.toUpperCase(), rel = cmd !== upper
    if (!['M', 'L', 'H', 'V', 'C', 'Z'].includes(upper)) throw new Error(`Unsupported SVG command ${cmd}`)
    if (upper === 'Z') { if (!path.points.length) throw new Error('SVG path must start with M'); path.closed = true; if (i !== tokens.length) throw new Error('Multiple SVG subpaths are unsupported'); break }
    const origin = current
    const point = (): Point => ({ x: number() + (rel ? origin.x : 0), y: number() + (rel ? origin.y : 0) })
    if (upper === 'M' && path.points.length) throw new Error('Multiple SVG subpaths are unsupported')
    if (!path.points.length && upper !== 'M') throw new Error('SVG path must start with M')
    if (upper === 'C') {
      const a = point(), b = point(), end = point()
      path.points.at(-1)!.out = relative(a, current)
      path.points.push({ ...end, in: relative(b, end) }); current = end
    } else {
      current = upper === 'H' ? { x: number() + (rel ? origin.x : 0), y: origin.y } : upper === 'V' ? { x: origin.x, y: number() + (rel ? origin.y : 0) } : point()
      path.points.push({ ...current })
    }
    if (upper === 'M') cmd = rel ? 'l' : 'L'
  }
  // Our serializer emits an explicit cubic back to the first point before Z.
  const first = path.points[0], last = path.points.at(-1)
  if (path.closed && path.points.length > 1 && first.x === last?.x && first.y === last.y) { first.in = last.in; path.points.pop() }
  return path
}
export function hitPathPoint(path: PathValue, point: Point, tolerance: number): number | null {
  let best = tolerance, index: number | null = null
  path.points.forEach((p, i) => { const d = Math.hypot(p.x - point.x, p.y - point.y); if (d <= best) { best = d; index = i } })
  return index
}
/** Screen-space hit testing accepts a mapper, so tolerance remains constant under skew/scale. */
export function hitPathSegment(path: PathValue, point: Point, tolerance: number, map: (p: Point) => Point = p => p): { index: number; t: number; distance: number } | null {
  let best: { index: number; t: number; distance: number } | null = null
  for (let index = 0; index < segmentCount(path); index++) {
    const c = pathSegment(path, index)
    const dist = (t: number) => { const p = map(cubicPoint(c, t)); return Math.hypot(point.x - p.x, point.y - p.y) }
    for (const t of [0, 1]) { const distance = dist(t); if (distance <= tolerance && (!best || distance < best.distance)) best = { index, t, distance } }
    // Search every coarse interval's local minimum; loops and cusps can have several minima.
    for (let j = 0; j < 32; j++) {
      let lo = j / 32, hi = (j + 1) / 32
      for (let k = 0; k < 16; k++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (dist(a) < dist(b)) hi = b; else lo = a }
      const t = (lo + hi) / 2, distance = dist(t)
      if (distance <= tolerance && (!best || distance < best.distance)) best = { index, t, distance }
    }
  }
  return best
}
export function pathBounds(path: PathValue): { x: number; y: number; width: number; height: number } | null {
  if (!path.points.length) return null
  const points: Point[] = [...path.points]
  for (let i = 0; i < segmentCount(path); i++) {
    const c = pathSegment(path, i)
    for (const axis of ['x', 'y'] as const) {
      const [p, q, r, s] = c.map(v => v[axis])
      const a = -p + 3 * q - 3 * r + s, b = 2 * (p - 2 * q + r), d = q - p
      const roots = Math.abs(a) < 1e-12 ? (Math.abs(b) < 1e-12 ? [] : [-d / b]) : b * b - 4 * a * d < 0 ? [] : [(-b + Math.sqrt(b * b - 4 * a * d)) / (2 * a), (-b - Math.sqrt(b * b - 4 * a * d)) / (2 * a)]
      for (const t of roots) if (t > 0 && t < 1) points.push(cubicPoint(c, t))
    }
  }
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }
}
export function togglePathSmooth(path: PathValue, index: number): PathValue {
  const next = clonePath(path), p = next.points[index]
  if (!p) return next
  if (p.in || p.out) { delete p.in; delete p.out; return next }
  const a = path.points[path.closed ? (index - 1 + path.points.length) % path.points.length : Math.max(0, index - 1)], b = path.points[path.closed ? (index + 1) % path.points.length : Math.min(path.points.length - 1, index + 1)]
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1
  const before = Math.hypot(p.x - a.x, p.y - a.y), after = Math.hypot(p.x - b.x, p.y - b.y)
  const size = (before && after ? Math.min(before, after) : before || after) / 3
  p.out = [dx / length * size, dy / length * size]; p.in = [-p.out[0], -p.out[1]]
  return next
}
