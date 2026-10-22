import { For } from 'solid-js'
import { registerTimelineTools } from './tools'
import { definePlugin, type PanelContext } from '@core/plugin-api'
import { Icon } from '@ui/icon'
import { useRegistry, useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { linkedSelection, Timeline } from './Timeline'
import './timeline.css'

function Toolbar(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const tool = useValue(app.view.tool)
  const tools = useRegistry(app.registries.timelineTools)
  const settings = useValue(app.settings.values)
  const ripple = () => (settings(), app.settings.get<boolean>('timeline.rippleMode'))
  const snapping = useValue(app.view.snapping)
  const linked = useValue(linkedSelection)
  return (
    <div class="tl-tools">
      <div class="tl-toolgroup">
        <For each={tools()}>{(t) => <button class={tool() === t.id ? 'on' : ''} data-tip={`${t.name}${t.key ? ` (${t.key})` : ''}`} onClick={() => app.run(`timeline.tool.${t.id}`)}><Icon name={t.icon} size={14} /></button>}</For>
      </div>
      <div class="tl-toolgroup">
        <button class={ripple() ? 'on' : ''} data-tip="Ripple mode (Shift+R)" onClick={() => app.run('timeline.toggleRippleMode')}><Icon name="ripple-trim" size={14} /></button>
        <button class={snapping() ? 'on' : ''} data-tip="Snapping (N)" onClick={() => app.run('timeline.snapping')}>
          <Icon name="magnet" size={14} />
        </button>
        <button class={linked() ? 'on' : ''} data-tip="Linked selection" onClick={() => linkedSelection.set(!linkedSelection.get())}>
          <Icon name="link" size={14} />
        </button>
      </div>
      <div class="tl-toolgroup">
        <button data-tip="Zoom out (-)" onClick={() => app.run('timeline.zoomOut')}>
          <Icon name="zoom-out" size={14} />
        </button>
        <button data-tip="Zoom to fit (Shift+Z)" onClick={() => app.run('timeline.zoomFit')}>
          <Icon name="scan" size={14} />
        </button>
        <button data-tip="Zoom in (=)" onClick={() => app.run('timeline.zoomIn')}>
          <Icon name="zoom-in" size={14} />
        </button>
      </div>
    </div>
  )
}

/** The DaVinci-style timeline: video tracks stacked above audio tracks, ruler + playhead, drag/trim/blade. */
export const timelinePlugin = definePlugin({
  id: 'cascade.panel.timeline',
  name: 'Timeline',
  activate(ctx) {
    ctx.panels.register({
      id: 'timeline',
      title: 'Timeline',
      icon: 'gantt-chart',
      region: 'bottom',
      order: 0,
      mount: solidMount(Timeline),
      actions: solidMount(Toolbar)
    })
    registerTimelineTools(ctx)
  }
})
