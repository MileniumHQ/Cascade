import { For } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { useProject } from '@ui/reactive'
import { Icon } from '@ui/icon'

export const TIMELINE_MIME = 'application/x-cascade-timeline'

/** Separate source entries avoid creating document media just by opening or dragging a tab. */
export function TimelineSources(props: { ctx: { app: CascadeAPI } }) {
  const app = props.ctx.app, project = useProject(app)
  return <section class="sc-section">
    <div class="sc-section-head sc-static"><span>Timelines</span></div>
    <div class="sc-timelines"><For each={project().timelineOrder}>{id => <div class="sc-timeline" classList={{ active: project().activeTimeline === id }} draggable={true}
      onDblClick={() => app.run('timeline.switch', id)}
      onDragStart={e => { e.dataTransfer?.setData(TIMELINE_MIME, id); e.dataTransfer?.setData('text/plain', project().timelines[id]?.name ?? 'Timeline'); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy' }}>
      <Icon name="layers" size={14} /><span>{project().timelines[id]?.name}</span>
      <button aria-label="Open timeline" data-tip="Open timeline" onClick={() => app.run('timeline.switch', id)}><Icon name="arrow-up-right" size={12} /></button>
    </div>}</For></div>
  </section>
}
