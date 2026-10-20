import type { Glyph as GlyphKind } from './model'

const PATHS: Record<GlyphKind, string> = {
  diamond: 'M7 0.9 L13.1 7 L7 13.1 L0.9 7 Z',
  circle: 'M7 1.3 A5.7 5.7 0 1 1 6.99 1.3 Z',
  square: 'M3 1.8 H11 Q12.2 1.8 12.2 3 V11 Q12.2 12.2 11 12.2 H3 Q1.8 12.2 1.8 11 V3 Q1.8 1.8 3 1.8 Z',
  hourglass: 'M2 1.8 H12 L7.9 7 L12 12.2 H2 L6.1 7 Z',
  triangle: 'M7 1.4 L12.9 12 H1.1 Z'
}

/** Keyframe glyph: the shape follows the easing of the segment that starts here. */
export function Glyph(props: { kind: GlyphKind; size?: number; class?: string }) {
  return (
    <svg class={`kf-glyph-svg ${props.class ?? ''}`} width={props.size ?? 14} height={props.size ?? 14} viewBox="0 0 14 14" aria-hidden="true">
      <path d={PATHS[props.kind] ?? PATHS.diamond} />
    </svg>
  )
}
