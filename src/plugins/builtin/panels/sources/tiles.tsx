import { Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { GeneratorContribution } from '@core/plugin-api'
import type { MediaItem } from '@shared/project'
import { Icon } from '@ui/icon'

interface PropPreset {
  type: string
  values?: Record<string, unknown>
}

/** The color a generator's fill/text property will start with (explicit preset, else the property default). */
function presetColor(app: CascadeAPI, media: MediaItem, propType: string, fallback: string): string {
  const presets = (media.data?.properties as PropPreset[] | undefined) ?? []
  const explicit = presets.find((p) => p.type === propType)?.values?.color
  if (typeof explicit === 'string') return explicit
  const def = app.registries.properties.get(propType)?.params.find((p) => p.id === 'color')?.default
  return typeof def === 'string' ? def : fallback
}

/**
 * Tile for sources that have no file behind them. Looks are derived from the generator's
 * clip data ("kind") and property presets, falling back to the generator's own icon.
 */
export function GeneratorTile(props: { media: MediaItem; generator: GeneratorContribution; app: CascadeAPI }) {
  const kind = () => (props.media.data?.clipData as { kind?: string } | undefined)?.kind
  return (
    <Show
      when={kind() === 'text' || kind() === 'solid' || kind() === 'shape'}
      fallback={
        <span class="sc-thumb-icon">
          <Icon name={props.generator.icon} size={22} />
        </span>
      }
    >
      <Show when={kind() === 'solid'}>
        <div class="sc-tile-solid" style={{ background: presetColor(props.app, props.media, 'fill', '#ffffff') }} />
      </Show>
      <Show when={kind() === 'shape'}>
        <div class="sc-tile-shape-bg">
          <div class="sc-tile-shape" style={{ background: presetColor(props.app, props.media, 'fill', '#c6f24e') }} />
        </div>
      </Show>
      <Show when={kind() === 'text'}>
        <div class="sc-tile-text">
          <span style={{ color: presetColor(props.app, props.media, 'text', '#ffffff') }}>Aa</span>
        </div>
      </Show>
    </Show>
  )
}
