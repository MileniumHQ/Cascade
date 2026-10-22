import type { CascadeAPI } from '@core/app'
import type { PresetContribution } from '@core/plugin-api'
import type { PropertyStyle } from '@core/property-style'

/** Preset `kind` for caption looks; the value is a PropertyStyle (parameter values per property type, `null` drops the type). */
export const CAPTION_STYLE_KIND = 'captions.style'
/** Setting holding the preset id of the style new captions get. */
export const CAPTION_STYLE_SETTING = 'captions.style'
export const DEFAULT_CAPTION_STYLE = `${CAPTION_STYLE_KIND}:clean`

export type CaptionStylePreset = PresetContribution<PropertyStyle>

/** Plain, readable captions: white with a dark outline and soft shadow (the base look in `captionClip`). */
const clean: PropertyStyle = {}

export const builtinCaptionStyles: { id: string; name: string; description: string; icon: string; value: PropertyStyle }[] = [
  { id: 'clean', name: 'Clean white', description: 'White text, dark outline, soft shadow', icon: 'captions', value: clean },
  {
    id: 'bold-yellow',
    name: 'Bold yellow',
    description: 'Heavy yellow text with a thick outline',
    icon: 'captions',
    value: { text: { color: '#ffe14d', weight: 900, stroke: 0.009, strokeColor: '#000000' } }
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'White text on a dark rounded box',
    icon: 'captions',
    value: {
      transform: { position: [0, 0.36] },
      size: { size: [0.86, 0.13], padding: 0.012 },
      text: { weight: 700, stroke: 0 },
      fill: { kind: 'solid', color: '#000000c0' },
      corners: { radius: 0.014 },
      shadow: null
    }
  },
  {
    id: 'outline',
    name: 'Outline',
    description: 'White text with a heavy black outline, no shadow',
    icon: 'captions',
    value: { text: { weight: 800, stroke: 0.011, strokeColor: '#000000' }, shadow: null }
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Smaller, lighter text with only a shadow',
    icon: 'captions',
    value: {
      transform: { position: [0, 0.4] },
      text: { size: 0.036, weight: 560, stroke: 0 },
      shadow: { offset: [0, 0.002], blur: 0.01, color: '#000000e6' }
    }
  }
]

/** All registered caption styles, in registry order. */
export const captionStyles = (app: CascadeAPI): CaptionStylePreset[] => app.registries.presets.all().filter((p): p is CaptionStylePreset => p.kind === CAPTION_STYLE_KIND)

/** The style new captions get (falls back to the first registered one when the chosen one is gone). */
export function currentCaptionStyle(app: CascadeAPI): CaptionStylePreset | undefined {
  const all = captionStyles(app)
  const id = app.settings.get<string | undefined>(CAPTION_STYLE_SETTING)
  return all.find((p) => p.id === id) ?? all.find((p) => p.id === DEFAULT_CAPTION_STYLE) ?? all[0]
}

/**
 * A style as a restyle patch. The base caption look is spelled out first so restyling a caption
 * that has an earlier style applied resets what the new one doesn't set.
 */
export function styleOverBase(style: PropertyStyle): PropertyStyle {
  const base: PropertyStyle = {
    transform: { position: [0, 0.34] },
    size: { size: [0.88, 0.16], padding: 0 },
    text: { size: 0.046, weight: 750, color: '#ffffff', stroke: 0.006, strokeColor: '#111111' },
    shadow: { offset: [0, 0.002], blur: 0.006, color: '#000000cc' },
    // Properties only some styles add; dropped unless the new style sets them.
    fill: null,
    corners: null
  }
  const out: PropertyStyle = { ...base }
  for (const [type, values] of Object.entries(style)) out[type] = values === null ? null : { ...(base[type] ?? {}), ...values }
  return out
}
