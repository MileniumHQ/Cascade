import { createMemo, type JSX } from 'solid-js'
import { ICON_ALIASES, MATERIAL_ICONS } from './material-icons'

const cache = new Map<string, string>()

/**
 * Resolve an icon name or raw <svg> into SVG markup. Names are Cascade's Lucide-style names ("film") or the
 * Material Symbol names they map to ("movie"); see scripts/gen-icons.mjs to add one. `strokeWidth` is the
 * Lucide-era weight (1.75 = regular); heavier values thicken the glyph with an outline.
 */
export function iconMarkup(icon: string | undefined, strokeWidth = 1.75): string {
  if (!icon) return ''
  if (icon.trim().startsWith('<svg')) return icon
  const key = `${icon}|${strokeWidth}`
  const hit = cache.get(key)
  if (hit) return hit
  const glyph = MATERIAL_ICONS[ICON_ALIASES[icon] ?? icon] ?? MATERIAL_ICONS.help
  const bold = strokeWidth > 1.75 ? ` stroke="currentColor" stroke-width="${Math.round((strokeWidth - 1.75) * 40)}" stroke-linejoin="round"` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"${bold}>${glyph}</svg>`
  cache.set(key, svg)
  return svg
}

export function Icon(props: { name: string | undefined; size?: number; stroke?: number; class?: string; style?: JSX.CSSProperties }) {
  const markup = createMemo(() => iconMarkup(props.name, props.stroke ?? 1.75))
  return (
    <span
      class={`icon ${props.class ?? ''}`}
      style={{ width: `${props.size ?? 16}px`, height: `${props.size ?? 16}px`, ...props.style }}
      innerHTML={markup()}
    />
  )
}
