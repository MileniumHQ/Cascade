import { createMemo, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { Clip } from '@shared/project'
import { formatTimecode } from '@shared/time'
import { Icon } from '@ui/icon'
import { IconButton, NumberField, Segmented, TextField } from '@ui/kit'
import { useRegistry } from '@ui/reactive'

const FITS = [
  { value: 'contain', label: 'Contain', tip: 'Fit inside the frame' },
  { value: 'cover', label: 'Cover', tip: 'Fill the frame, cropping overflow' },
  { value: 'fill', label: 'Fill', tip: 'Stretch to the frame' },
  { value: 'none', label: 'None', tip: 'Native size' }
] as const

export function TypeChip(props: { app: CascadeAPI; type: string }) {
  const types = useRegistry(props.app.registries.mediaTypes)
  const mt = createMemo(() => (types(), props.app.registries.mediaTypes.get(props.type)))
  return (
    <span class="ins-chip" style={{ '--chip': mt()?.color ?? 'var(--muted)' }}>
      <Icon name={mt()?.icon ?? 'file'} size={13} />
      <span>{mt()?.name ?? props.type}</span>
    </span>
  )
}

function Timecode(props: { label: string; value: string; tip?: string }) {
  return (
    <div class="ins-tc" data-tip={props.tip}>
      <span class="ins-tc-label">{props.label}</span>
      <span class="ins-tc-value tnum">{props.value}</span>
    </div>
  )
}

export function ClipHeader(props: { app: CascadeAPI; clip: Clip }) {
  const app = props.app
  const types = useRegistry(app.registries.mediaTypes)
  const mt = createMemo(() => (types(), app.registries.mediaTypes.get(props.clip.type)))
  const fps = () => app.fps()
  const fit = () => (typeof props.clip.data.fit === 'string' ? (props.clip.data.fit as string) : null)
  const showFit = () => mt()?.track !== 'audio' && fit() !== null
  const showSpeed = () => !!mt()?.timeBased

  return (
    <div class="ins-clip">
      <div class="ins-clip-top">
        <div class="ins-clip-icon" style={{ '--chip': mt()?.color ?? 'var(--muted)' }}>
          <Icon name={mt()?.icon ?? 'file'} size={16} />
        </div>
        <div class="ins-clip-id">
          <TextField
            class="ins-clip-name"
            value={props.clip.name}
            placeholder="Clip name"
            onChange={(name) => {
              const v = name.trim()
              if (v && v !== props.clip.name) app.edit.updateClip(props.clip.id, { name: v })
            }}
          />
          <div class="ins-clip-meta">
            <TypeChip app={app} type={props.clip.type} />
            <Show when={props.clip.linkId}>
              <button class="ins-linked" data-tip="Linked to another clip — click to unlink" onClick={() => app.edit.unlink([props.clip.id])}>
                <Icon name="link-2" size={12} />
                <span>Linked</span>
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div class="ins-tcs">
        <Timecode label="Start" value={formatTimecode(props.clip.start, fps())} tip="Position on the timeline" />
        <Timecode label="Duration" value={formatTimecode(props.clip.duration, fps())} />
        <Timecode label="Source in" value={formatTimecode(props.clip.sourceIn, fps())} tip="Where this clip begins inside its source" />
      </div>

      <Show when={showSpeed() || showFit()}>
        <div class="ins-clip-opts">
          <Show when={showSpeed()}>
            <div class="ins-opt">
              <NumberField
                prefix="Speed"
                value={props.clip.speed ?? 1}
                min={0.05}
                max={32}
                step={0.05}
                precision={2}
                suffix="×"
                width="112px"
                onChange={(speed, gesture) => app.edit.updateClip(props.clip.id, { speed }, { gesture })}
              />
              <Show when={(props.clip.speed ?? 1) !== 1}>
                <IconButton icon="rotate-ccw" size="sm" tip="Reset speed" onClick={() => app.edit.updateClip(props.clip.id, { speed: 1 })} />
              </Show>
            </div>
          </Show>
          <Show when={showFit()}>
            <div class="ins-opt grow">
              <Segmented value={fit()! as (typeof FITS)[number]['value']} options={[...FITS]} onChange={(v) => app.edit.setClipData(props.clip.id, { fit: v })} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
