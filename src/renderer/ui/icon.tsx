import { icons } from 'lucide'
import { createMemo, type JSX } from 'solid-js'

type IconNode = [string, Record<string, string | number>][]

const cache = new Map<string, string>()

const pascal = (name: string) =>
  name
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('')

/** Resolve a Lucide name ("film", "Film") or raw <svg> into inner SVG markup. */
export function iconMarkup(icon: string | undefined, strokeWidth = 1.75): string {
  if (!icon) return ''
  if (icon.trim().startsWith('<svg')) return icon
  const key = `${icon}|${strokeWidth}`
  const hit = cache.get(key)
  if (hit) return hit
  const node = ((icons as unknown as Record<string, IconNode>)[pascal(icon)] ??
    (icons as unknown as Record<string, IconNode>)[icon]) as IconNode | undefined
  if (!node) return iconMarkup('circle-help', strokeWidth)
  const inner = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
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
