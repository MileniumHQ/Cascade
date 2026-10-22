import { createMemo, For, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { ParamDef, ParamEditorContext } from '@core/plugin-api'
import { findTransition } from '@core/transitions'
import type { Id } from '@shared/project'
import { FLICKS, frameDuration } from '@shared/time'
import { Button, NumberField, Select } from '@ui/kit'
import { useProject, useRegistry } from '@ui/reactive'
import { unitHelpers } from '@ui/param-units'
import { MountHost } from '@ui/mount-host'

/** Static transition parameters use the same framework-neutral editors as clip properties. */
function TransitionParam(props: { app: CascadeAPI; id: Id; def: ParamDef }) {
  const app = props.app, types = useRegistry(app.registries.paramTypes)
  const type = createMemo(() => (types(), app.registries.paramTypes.get(props.def.type)))
  const ctx: ParamEditorContext = {
    app, def: props.def,
    get: () => findTransition(app.timeline(), props.id)?.transition.params[props.def.id] ?? props.def.default,
    set: (value, opts) => app.edit.updateTransition(props.id, { params: { [props.def.id]: value } }, opts),
    subscribe: fn => { const off = app.doc.onChange.on(fn); return () => off.dispose() },
    ...unitHelpers(app, props.def.unit), animated: false, keyed: () => false
  }
  return <div class="ins-row" classList={{ stack: props.def.type === 'color' }}><div class="ins-label">{props.def.label}</div>
    <Show when={type()} keyed>{t => <MountHost class="ins-editor" mount={t.editor} ctx={ctx} />}</Show>
  </div>
}

export function TransitionInspector(props: { ctx: { app: CascadeAPI; id: Id } }) {
  const app = props.ctx.app, id = props.ctx.id, project = useProject(app), types = useRegistry(app.registries.transitions)
  const found = createMemo(() => (project(), findTransition(app.timeline(), id)))
  const def = createMemo(() => (types(), app.registries.transitions.get(found()?.transition.type ?? '')))
  const params = createMemo(() => def()?.params.filter(p => !p.hidden) ?? [])
  return <Show when={found()}>{f => <div class="ins-scroll">
    <fieldset class="ins-card" disabled={f().track.locked} style={{ padding: '12px', border: '0', margin: '0' }}>
      <div class="ins-row"><div class="ins-label">Transition</div><Select value={f().transition.type} options={[
        ...(!def() ? [{ value: f().transition.type, label: `${f().transition.type} (missing plugin)` }] : []),
        ...types().filter(t => t.kinds.includes(f().track.kind) && (f().transition.from && f().transition.to || t.singleSided !== false)).map(t => ({ value: t.id, label: t.name, icon: t.icon }))
      ]} onChange={type => app.edit.updateTransition(id, { type })} /></div>
      <div class="ins-row"><div class="ins-label">Duration</div><NumberField value={f().transition.duration / FLICKS} min={frameDuration(app.fps()) / FLICKS} step={frameDuration(app.fps()) / FLICKS} precision={3} suffix="s" disabled={f().track.locked}
        onChange={(duration, gesture) => app.edit.updateTransition(id, { duration: Math.round(duration * FLICKS) }, { gesture })} /></div>
      <Show when={f().transition.from && f().transition.to}><div class="ins-row"><div class="ins-label">Alignment</div><Select value={f().transition.align} options={[
        { value: 'center', label: 'Center on cut' }, { value: 'end', label: 'End at cut' }, { value: 'start', label: 'Start at cut' }
      ]} onChange={align => app.edit.updateTransition(id, { align })} /></div></Show>
      <For each={params()}>{p => <TransitionParam app={app} id={id} def={p} />}</For>
      <Button size="sm" icon="trash-2" disabled={f().track.locked} onClick={() => app.edit.removeTransitions([id])}>Delete transition</Button>
    </fieldset>
  </div>}</Show>
}
