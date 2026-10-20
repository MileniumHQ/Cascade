import { createSignal, For } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { FrameRate } from '@shared/time'
import { Button, ColorField, Modal, NumberField, Select, TextField } from '../ui/kit'

export { RESOLUTION_PRESETS, FPS_PRESETS, fpsKey } from '@shared/formats'
import { RESOLUTION_PRESETS, FPS_PRESETS, fpsKey } from '@shared/formats'

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
