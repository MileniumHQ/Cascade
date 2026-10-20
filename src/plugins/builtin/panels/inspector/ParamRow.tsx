import { createMemo, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { ParamDef } from '@core/plugin-api'
import type { Id } from '@shared/project'
import { openContextMenu } from '@ui/kit'
import { useRegistry } from '@ui/reactive'
import { makeParamContext } from './context'
import { MountHost } from './MountHost'
import { KeyframeControl, useKeyframeState } from './KeyframeControl'

/**
 * Keyframes are offered for params that can be interpolated (their type has `interpolate`).
 * Discrete types (select, toggle) only get them when the def opts in with `animatable: true`;
 * `animatable: false` always opts out. Text and fonts are never keyframed by default.
 */
export const isAnimatable = (app: CascadeAPI, def: ParamDef) => def.animatable ?? !!app.registries.paramTypes.get(def.type)?.interpolate

export function ParamRow(props: { app: CascadeAPI; clipId: Id; propId: Id; def: ParamDef }) {
  const { app, clipId, propId, def } = props
  const types = useRegistry(app.registries.paramTypes)
  // Remount the editor only when the param type's contribution object itself changes (hot reload).
  const type = createMemo(() => (types(), app.registries.paramTypes.get(def.type)))
  const ctx = makeParamContext(app, clipId, propId, def)
  const animatable = isAnimatable(app, def)
  const kf = useKeyframeState(app, ctx, clipId, propId)

  const rowMenu = (e: MouseEvent) => {
    // Text fields keep their own copy/paste menu.
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
    openContextMenu(e, [
      { label: 'Clear keyframes', icon: 'diamond-minus', disabled: !kf().animated, run: () => app.edit.clearKeyframes(clipId, propId, def.id) },
      {
        label: 'Reset to default',
        icon: 'rotate-ccw',
        run: () => app.edit.setParam(clipId, propId, def.id, structuredClone(def.default))
      }
    ])
  }

  return (
    <div class="ins-row" classList={{ stack: def.type === 'color' || (def.type === 'text' && !!def.config?.multiline), keyed: animatable && kf().keyed, animated: animatable && kf().animated }} onContextMenu={rowMenu}>
      <div class="ins-label" data-tip={def.label}>
        {def.label}
      </div>
      <Show when={type()} keyed fallback={<div class="ins-missing">Unknown parameter type “{def.type}”</div>}>
        {(t) => <MountHost class="ins-editor" mount={t.editor} ctx={ctx} />}
      </Show>
      <Show when={animatable}>
        <KeyframeControl app={app} clipId={clipId} propId={propId} paramId={def.id} state={kf} />
      </Show>
    </div>
  )
}
