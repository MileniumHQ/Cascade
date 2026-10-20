import { definePlugin, type PanelContext } from '@core/plugin-api'
import { Icon } from '@ui/icon'
import { useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { linkedSelection, Timeline, timelineTool } from './Timeline'
import './timeline.css'

function Toolbar(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const tool = useValue(timelineTool)
  const snapping = useValue(app.view.snapping)
  const linked = useValue(linkedSelection)
  return (
    <div class="tl-tools">
      <div class="tl-toolgroup">
        <button class={tool() === 'select' ? 'on' : ''} data-tip="Select (A)" onClick={() => timelineTool.set('select')}>
          <Icon name="mouse-pointer-2" size={14} />
        </button>
        <button class={tool() === 'blade' ? 'on' : ''} data-tip="Blade (B)" onClick={() => timelineTool.set('blade')}>
          <Icon name="scissors" size={14} />
        </button>
      </div>
      <div class="tl-toolgroup">
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
    ctx.commands.register({ id: 'timeline.tool.select', title: 'Select tool', category: 'Timeline', run: () => timelineTool.set('select') })
    ctx.commands.register({ id: 'timeline.tool.blade', title: 'Blade tool', category: 'Timeline', run: () => timelineTool.set('blade') })
    ctx.keybindings.register({ id: 'timeline.tool.select:A', command: 'timeline.tool.select', key: 'A' })
    ctx.keybindings.register({ id: 'timeline.tool.blade:B', command: 'timeline.tool.blade', key: 'B' })
  }
})
