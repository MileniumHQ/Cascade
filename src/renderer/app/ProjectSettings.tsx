import { createSignal, For } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { FrameRate } from '@shared/time'
import { Button, ColorField, Modal, NumberField, Select, TextField } from '../ui/kit'

export const RESOLUTION_PRESETS = [
  { id: '1080p', label: '1080p', sub: '1920 × 1080', w: 1920, h: 1080, icon: 'monitor' },
  { id: '4k', label: '4K UHD', sub: '3840 × 2160', w: 3840, h: 2160, icon: 'monitor' },
  { id: '720p', label: '720p', sub: '1280 × 720', w: 1280, h: 720, icon: 'monitor' },
  { id: 'vertical', label: 'Vertical', sub: '1080 × 1920', w: 1080, h: 1920, icon: 'smartphone' },
  { id: 'square', label: 'Square', sub: '1080 × 1080', w: 1080, h: 1080, icon: 'square' },
  { id: 'cinema', label: 'Cinema', sub: '2048 × 858', w: 2048, h: 858, icon: 'clapperboard' }
]

export const FPS_PRESETS: { value: string; label: string; fps: FrameRate }[] = [
  { value: '23.976', label: '23.976', fps: { num: 24000, den: 1001 } },
  { value: '24', label: '24', fps: { num: 24, den: 1 } },
  { value: '25', label: '25', fps: { num: 25, den: 1 } },
  { value: '29.97', label: '29.97', fps: { num: 30000, den: 1001 } },
  { value: '30', label: '30', fps: { num: 30, den: 1 } },
  { value: '50', label: '50', fps: { num: 50, den: 1 } },
  { value: '59.94', label: '59.94', fps: { num: 60000, den: 1001 } },
  { value: '60', label: '60', fps: { num: 60, den: 1 } },
  { value: '120', label: '120', fps: { num: 120, den: 1 } }
]

export const fpsKey = (f: FrameRate) => FPS_PRESETS.find((p) => p.fps.num === f.num && p.fps.den === f.den)?.value ?? String(f.num / f.den)

export function FormatPicker(props: {
  width: number
  height: number
  fps: FrameRate
  onChange: (v: { width: number; height: number; fps: FrameRate }) => void
}) {
  return (
    <div class="format-picker">
      <div class="preset-grid">
        <For each={RESOLUTION_PRESETS}>
          {(p) => (
            <button
              class={`preset ${props.width === p.w && props.height === p.h ? 'on' : ''}`}
              onClick={() => props.onChange({ width: p.w, height: p.h, fps: props.fps })}
            >
              <span class="preset-shape" style={{ 'aspect-ratio': `${p.w} / ${p.h}` }} />
              <span class="preset-label">{p.label}</span>
              <span class="preset-sub tnum">{p.sub}</span>
            </button>
          )}
        </For>
      </div>
      <div class="field-row">
        <label>Resolution</label>
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <NumberField value={props.width} min={16} max={16384} step={2} suffix="w" onChange={(v) => props.onChange({ width: Math.round(v), height: props.height, fps: props.fps })} />
          <span style={{ color: 'var(--dim)' }}>×</span>
          <NumberField value={props.height} min={16} max={16384} step={2} suffix="h" onChange={(v) => props.onChange({ width: props.width, height: Math.round(v), fps: props.fps })} />
        </div>
      </div>
      <div class="field-row">
        <label>Frame rate</label>
        <Select
          value={fpsKey(props.fps)}
          options={FPS_PRESETS.map((p) => ({ value: p.value, label: `${p.label} fps` }))}
          onChange={(v) => props.onChange({ width: props.width, height: props.height, fps: FPS_PRESETS.find((p) => p.value === v)!.fps })}
        />
      </div>
    </div>
  )
}

export function ProjectSettingsModal(props: { app: CascadeApp; onClose: () => void }) {
  const s = props.app.project().settings
  const [name, setName] = createSignal(props.app.project().name)
  const [fmt, setFmt] = createSignal({ width: s.width, height: s.height, fps: s.fps })
  const [bg, setBg] = createSignal(s.background)
  const apply = () => {
    if (name() !== props.app.project().name) props.app.edit.renameProject(name())
    props.app.edit.setProjectSettings({ ...fmt(), background: bg() })
    props.onClose()
  }
  return (
    <Modal
      title="Project settings"
      icon="sliders-horizontal"
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <div class="field-row">
        <label>Name</label>
        <TextField value={name()} onChange={setName} onInput={setName} />
      </div>
      <FormatPicker {...fmt()} onChange={setFmt} />
      <div class="field-row">
        <label>Background</label>
        <ColorField value={bg()} onChange={(v) => setBg(v)} />
      </div>
      <p class="hint">
        Cascade renders resolution-independently — changing the size keeps your layout. Export can use any size and frame rate.
      </p>
    </Modal>
  )
}
