import { createSignal, For, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { useProject, useValue } from '@ui/reactive'
import { Icon } from '@ui/icon'
import { openContextMenu } from '@ui/kit'
import './timeline-tabs.css'

const MIME = 'application/x-cascade-timeline-tab'

export function TimelineTabs(props: { app: CascadeAPI }) {
  const app = props.app, project = useProject(app), history = useValue(app.edit.timelineHistory)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const sub = app.events.on<string>('timeline:rename', id => setRenaming(id))
  onCleanup(() => sub.dispose())
  const commit = (id: string, name: string) => {
    if (renaming() !== id) return
    setRenaming(null)
    app.run('timeline.renameTimeline', id, name)
  }
  return <div class="tl-tabs" role="tablist" aria-label="Timelines">
    <Show when={history().some(id => !!project().timelines[id])}>
      <button class="tl-tab-back" aria-label="Previous timeline" data-tip={history().map(id => project().timelines[id]?.name).filter(Boolean).join(' › ')} onClick={() => app.run('timeline.back')}><Icon name="arrow-left" size={13} /></button>
    </Show>
    <For each={project().timelineOrder}>{id => <div class="tl-tab" classList={{ active: project().activeTimeline === id }} role="tab" aria-selected={project().activeTimeline === id} tabindex={0}
      draggable={renaming() !== id} onClick={() => app.run('timeline.switch', id)}
      onKeyDown={e => { if (e.target instanceof HTMLInputElement) return; if (e.key === 'Enter' || e.key === ' ') app.run('timeline.switch', id) }}
      onDblClick={() => app.run('timeline.renameTimeline', id)}
      onDragStart={e => { e.dataTransfer?.setData(MIME, id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' }}
      onDragOver={e => { if (e.dataTransfer?.types.includes(MIME)) e.preventDefault() }}
      onDrop={e => { const moved = e.dataTransfer?.getData(MIME); if (moved) { e.preventDefault(); app.run('timeline.reorderTimeline', moved, project().timelineOrder.indexOf(id)) } }}
      onContextMenu={e => { e.preventDefault(); const reason = app.edit.deleteTimelineReason(id); openContextMenu(e, [
        { label: 'Duplicate', icon: 'copy-plus', run: () => app.run('timeline.duplicateTimeline', id) },
        { label: 'Rename', icon: 'pencil', run: () => app.run('timeline.renameTimeline', id) },
        { separator: true },
        { label: reason ? `Delete — ${reason}` : 'Delete', icon: 'trash-2', disabled: !!reason, danger: true, run: () => app.run('timeline.deleteTimeline', id) }
      ]) }}>
      <Icon name="layers" size={12} />
      <Show when={renaming() === id} fallback={<span>{project().timelines[id]?.name}</span>}>
        <input aria-label="Timeline name" value={project().timelines[id]?.name} ref={el => queueMicrotask(() => { el.focus(); el.select() })}
          onClick={e => e.stopPropagation()} onDblClick={e => e.stopPropagation()} onBlur={e => commit(id, e.currentTarget.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(id, e.currentTarget.value); else if (e.key === 'Escape') setRenaming(null) }} />
      </Show>
    </div>}</For>
    <button class="tl-tab-add" aria-label="New timeline" data-tip="New timeline" onClick={() => app.run('timeline.create')}><Icon name="plus" size={14} /></button>
  </div>
}
