/** Shape-preserving piecewise cubic Hermite curves, in normalized input/output units. */
export type CurvePoint = [number, number]
export const curveChannels = ['master', 'r', 'g', 'b'] as const
export type CurveChannel = typeof curveChannels[number]
export type CurveValue = Record<CurveChannel, CurvePoint[]>
const clamp = (n: number) => Math.max(0, Math.min(1, n))
export const identityCurve = (): CurvePoint[] => [[0, 0], [1, 1]]
export const defaultCurves = (): CurveValue => ({ master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() })
export function coerceCurvePoints(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) return identityCurve()
  const sorted = value.filter(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n))).map(p => [clamp(p[0]), clamp(p[1])] as CurvePoint).sort((a, b) => a[0] - b[0])
  const points = sorted.filter((p, i) => !i || p[0] - sorted[i - 1][0] > 1e-6)
  if (!points.length) return identityCurve()
  if (points[0][0] !== 0) points.unshift([0, 0])
  if (points.at(-1)![0] !== 1) points.push([1, 1])
  return points
}
export function coerceCurves(value: unknown): CurveValue {
  const v = value as Partial<CurveValue> | null
  return Object.fromEntries(curveChannels.map(c => [c, coerceCurvePoints(v?.[c])])) as CurveValue
}
export function interpolateCurves(a: CurveValue, b: CurveValue, t: number): CurveValue {
  a = coerceCurves(a); b = coerceCurves(b)
  if (curveChannels.some(c => a[c].length !== b[c].length)) return t >= 1 ? b : a
  // Easing can overshoot; keep x ordered, finite and within the curve domain.
  t = clamp(t)
  return Object.fromEntries(curveChannels.map(c => [c, a[c].map((p, i) => [p[0] + (b[c][i][0] - p[0]) * t, p[1] + (b[c][i][1] - p[1]) * t])])) as CurveValue
}
/** PCHIP weighted harmonic tangents preserve monotonicity per interval, including extrema. */
export function compileCurve(value: CurvePoint[]): (x: number) => number {
  const p = coerceCurvePoints(value), n = p.length
  const h = p.slice(1).map((q, i) => q[0] - p[i][0]), d = p.slice(1).map((q, i) => (q[1] - p[i][1]) / h[i])
  const m = new Array<number>(n).fill(0)
  const endpoint = (h0: number, h1: number, d0: number, d1: number) => {
    const slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
    return Math.sign(slope) !== Math.sign(d0) ? 0 : Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0) ? 3 * d0 : slope
  }
  if (n === 2) m[0] = m[1] = d[0]
  else {
    m[0] = endpoint(h[0], h[1], d[0], d[1]); m[n - 1] = endpoint(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
    for (let i = 1; i < n - 1; i++) if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    }
  }
  return x => {
    x = clamp(x)
    let i = 0
    while (i < n - 2 && p[i + 1][0] < x) i++
    const t = (x - p[i][0]) / h[i], t2 = t * t, t3 = t2 * t
    return clamp((2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h[i] * m[i + 1])
  }
}
/** RGBA lookup: RGB includes the master curve after each channel, alpha is unchanged. */
export function bakeCurves(value: CurveValue, size = 256): Uint8Array {
  if (!Number.isInteger(size) || size < 2) throw new RangeError('Curve texture needs at least two samples')
  const v = coerceCurves(value), master = compileCurve(v.master), rgb = [v.r, v.g, v.b].map(compileCurve), data = new Uint8Array(size * 4)
  for (let i = 0; i < size; i++) { for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(master(rgb[c](i / (size - 1))) * 255); data[i * 4 + 3] = 255 }
  return data
}
/** Two independent 32-bit hashes of the canonical value make a compact immutable cache key. */
export function curveKey(v: CurveValue): string {
  const text = JSON.stringify(coerceCurves(v))
  let a = 0x811c9dc5, b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193)
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b)
  }
  return `curves:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}
