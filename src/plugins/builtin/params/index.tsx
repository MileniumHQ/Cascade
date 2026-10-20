import { Show } from 'solid-js'
import { definePlugin, type ParamDef, type ParamEditorContext, type ParamTypeContribution } from '@core/plugin-api'
import { lerpColor } from '@shared/color'
import { ColorField, NumberField, Select, Segmented, TextField, Toggle } from '@ui/kit'
import { solidMount, useSub } from '../solid'
import { FontPicker } from './FontPicker'

const lerp = (a: number, b: number, p: number) => a + (b - a) * p
const clampDef = (v: number, d: ParamDef) => Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, v))

/** Inspector row state: accent when keyed at the playhead, sky when animated. */
const stateOf = (ctx: ParamEditorContext<any>): 'keyed' | 'animated' | null => (ctx.keyed() ? 'keyed' : ctx.animated ? 'animated' : null)

function NumberEditor(props: { ctx: ParamEditorContext<number> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => ({ value: ctx.get(), state: stateOf(ctx) }))
  const step = () => ctx.def.step ?? (ctx.def.unit === 'percent' ? 1 : ctx.def.unit?.startsWith('frame') ? 1 : 0.1)
  return (
    <NumberField
      value={ctx.toDisplay(v().value)}
      step={step()}
      min={ctx.def.min !== undefined ? ctx.toDisplay(ctx.def.min) : undefined}
      max={ctx.def.max !== undefined ? ctx.toDisplay(ctx.def.max) : undefined}
      suffix={ctx.unitLabel()}
      state={v().state}
      onChange={(n, phase) => ctx.set(clampDef(ctx.fromDisplay(n), ctx.def), { gesture: phase })}
    />
  )
}

function Vec2Editor(props: { ctx: ParamEditorContext<[number, number]> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => ({ value: ctx.get() ?? [0, 0], state: stateOf(ctx) }))
  const setAxis = (axis: 0 | 1, n: number, phase: 'start' | 'update' | 'end') => {
    const cur = [...v().value] as [number, number]
    cur[axis] = ctx.fromDisplay(n, axis)
    ctx.set(cur, { gesture: phase })
  }
  return (
    <div class="param-vec2">
      <NumberField value={ctx.toDisplay(v().value[0], 0)} step={ctx.def.step ?? 1} prefix="X" suffix={ctx.unitLabel(0)} state={v().state} onChange={(n, p) => setAxis(0, n, p)} />
      <NumberField value={ctx.toDisplay(v().value[1], 1)} step={ctx.def.step ?? 1} prefix="Y" suffix={ctx.unitLabel(1)} state={v().state} onChange={(n, p) => setAxis(1, n, p)} />
    </div>
  )
}

function ColorEditor(props: { ctx: ParamEditorContext<string> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => ({ value: ctx.get(), state: stateOf(ctx) }))
  return <ColorField value={v().value} state={v().state} onChange={(c, phase) => ctx.set(c, { gesture: phase })} />
}

function SelectEditor(props: { ctx: ParamEditorContext<string> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => ctx.get())
  const opts = ctx.def.options ?? []
  return (
    <Show
      when={ctx.def.config?.segmented && opts.length <= 5}
      fallback={<Select value={String(v())} options={opts.map((o) => ({ value: o.value, label: o.label, icon: o.icon }))} onChange={(x) => ctx.set(x)} />}
    >
      <Segmented value={String(v())} options={opts.map((o) => ({ value: o.value, label: o.icon ? undefined : o.label, icon: o.icon, tip: o.label }))} onChange={(x) => ctx.set(x)} />
    </Show>
  )
}

function ToggleEditor(props: { ctx: ParamEditorContext<boolean> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => !!ctx.get())
  return <Toggle value={v()} onChange={(x) => ctx.set(x)} />
}

function TextEditor(props: { ctx: ParamEditorContext<string> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => String(ctx.get() ?? ''))
  return <TextField value={v()} multiline={!!ctx.def.config?.multiline} onChange={(x) => ctx.set(x)} onInput={(x) => ctx.set(x, { gesture: 'update' })} />
}

function FontEditor(props: { ctx: ParamEditorContext<string> }) {
  const { ctx } = props
  const v = useSub(ctx.subscribe, () => String(ctx.get() ?? 'Inter'))
  return <FontPicker app={ctx.app} value={v()} onChange={(x) => ctx.set(x)} />
}

const num: ParamTypeContribution<number> = {
  id: 'number',
  interpolate: lerp,
  coerce: (v, d) => clampDef(Number(v ?? d.default) || 0, d),
  editor: solidMount(NumberEditor),
  format: (v) => String(+Number(v).toFixed(3)),
  channels: (v) => [v]
}

/** Built-in parameter types. Properties pick them by id in their ParamDefs. */
export const paramsPlugin = definePlugin({
  id: 'cascade.params',
  name: 'Parameter types',
  activate(ctx) {
    const types: ParamTypeContribution[] = [
      num,
      { ...num, id: 'angle', format: (v) => `${+Number(v).toFixed(1)}°` },
      {
        id: 'vec2',
        interpolate: (a: [number, number], b: [number, number], p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p)],
        coerce: (v, d) => (Array.isArray(v) && v.length === 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : (d.default as [number, number])),
        editor: solidMount(Vec2Editor),
        format: (v: [number, number]) => `${+v[0].toFixed(3)}, ${+v[1].toFixed(3)}`,
        channels: (v: [number, number]) => v
      },
      { id: 'color', interpolate: lerpColor, editor: solidMount(ColorEditor), format: (v: string) => v },
      { id: 'select', editor: solidMount(SelectEditor), format: (v: string, d) => d.options?.find((o) => o.value === v)?.label ?? String(v) },
      { id: 'toggle', editor: solidMount(ToggleEditor), coerce: (v) => !!v, format: (v: boolean) => (v ? 'On' : 'Off') },
      { id: 'text', editor: solidMount(TextEditor), coerce: (v) => String(v ?? ''), format: (v: string) => (v.length > 24 ? v.slice(0, 23) + '…' : v) },
      { id: 'font', editor: solidMount(FontEditor), format: (v: string) => v }
    ]
    for (const t of types) ctx.paramTypes.register(t)
  }
})

