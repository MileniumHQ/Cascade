/** Minimal CSS color parsing (hex / rgb[a]) shared by the UI and the stage. */
export function parseColor(c: string): [number, number, number, number] {
  const s = (c || '').trim()
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('')
    const n = parseInt(h.slice(0, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
  }
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
  }
  return [255, 255, 255, 1]
}

export const toHex = ([r, g, b, a]: [number, number, number, number]) => {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ''}`
}

export const lerpColor = (a: string, b: string, p: number) => {
  const x = parseColor(a)
  const y = parseColor(b)
  const m = x.map((v, i) => v + (y[i] - v) * p) as [number, number, number, number]
  return `rgba(${Math.round(m[0])}, ${Math.round(m[1])}, ${Math.round(m[2])}, ${+m[3].toFixed(4)})`
}
