import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { definePlugin, type PanelContext } from '@core/plugin-api'
import { IconButton } from '@ui/kit'
import { useProject, useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { useGatedTime, type PanelState } from './context'
import { DopeSheet } from './DopeSheet'
import { EasingEditor } from './EasingEditor'
import { KfMenu } from './KfMenu'
import { keyframesUi } from './state'
import { resolveRefs, type KfRef } from './model'
import './keyframes.css'

function KeyframesPanel(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const ui = keyframesUi(app)
  const project = useProject(app)
  const [visible, setVisible] = createSignal(false)
  onCleanup(props.ctx.onVisibility(setVisible) ?? (() => {}))
  const time = useGatedTime(app, visible)
  const sidebar = useValue(ui.sidebar)
  const [menu, setMenu] = createSignal<{ at: { x: number; y: number }; refs: KfRef[] } | null>(null)

  // Keep the keyframe selection honest: only the shown clip's keyframes, and only ones that still exist.
  const selClips = useValue(app.selection.clips)
  createEffect(() => {
    const p = project()
    const shown = selClips()[selClips().length - 1]
    const cur = app.selection.keyframes.get()
    if (!cur.length) return
    const alive = resolveRefs(p, p.activeTimeline, cur.filter((r) => r.clipId === shown)).map((x) => x.ref)
    if (alive.length !== cur.length) app.selection.keyframes.set(alive)
  })

  const s: PanelState = {
    app,
    ui,
    project,
    time,
    visible,
    openMenu: (e, refs) => setMenu({ at: { x: e.clientX, y: e.clientY }, refs })
  }

  return (
    <div class="kf">
      <div class="kf-main">
        <DopeSheet s={s} />
      </div>
      <Show when={sidebar()}>
        <EasingEditor s={s} />
      </Show>
      <Show when={menu()} keyed>
        {(m) => <KfMenu s={s} at={m.at} refs={m.refs} onClose={() => setMenu(null)} />}
      </Show>
    </div>
  )
}

function KeyframesActions(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const ui = keyframesUi(app)
  const sidebar = useValue(ui.sidebar)
  const graph = useValue(ui.graph)
  return (
    <div class="kf-actions">
      <IconButton size="sm" icon="chevron-left" tip="Previous keyframe" kbd="[" onClick={() => app.run('keyframes.prev')} />
      <IconButton size="sm" icon="chevron-right" tip="Next keyframe" kbd="]" onClick={() => app.run('keyframes.next')} />
      <span class="kf-actions-sep" />
      <IconButton size="sm" icon="maximize" tip="Fit to clip" onClick={() => ui.fit.current?.()} />
      <IconButton size="sm" icon="chart-spline" active={graph()} tip="Graph view" onClick={() => ui.graph.set(!ui.graph.get())} />
      <IconButton size="sm" icon="panel-right" active={sidebar()} tip="Easing editor" onClick={() => ui.sidebar.set(!ui.sidebar.get())} />
    </div>
  )
}

export const keyframesPlugin = definePlugin({
  id: 'cascade.panels.keyframes',
  name: 'Keyframes panel',
  activate(ctx) {
    ctx.panels.register({
      id: 'keyframes',
      title: 'Keyframes',
      icon: 'diamond',
      region: 'bottom',
      order: 1,
      mount: solidMount(KeyframesPanel),
      actions: solidMount(KeyframesActions)
    })
  }
})
