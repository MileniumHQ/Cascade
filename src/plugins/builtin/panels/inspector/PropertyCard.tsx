import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { evaluateProperty, isAnimated } from '@core/evaluate'
import type { Id, PropertyInstance } from '@shared/project'
import { Icon } from '@ui/icon'
import { IconButton, openMenu, Toggle, type Anchor } from '@ui/kit'
import { useRegistry, useValue } from '@ui/reactive'
import { instanceOf, makePropertyContext, subscribeEditing } from './context'
import { MountHost } from '@ui/mount-host'
import { ParamRow } from './ParamRow'
import { isCollapsed, setCardCollapsed } from './state'

export interface CardProps {
  app: CascadeAPI
  clipId: Id
  id: Id
  index: () => number
  count: () => number
  dragging: () => boolean
  onDragStart: (e: PointerEvent, id: Id) => void
}

export function PropertyCard(props: CardProps) {
  const { app, clipId, id } = props
  // Latest known instance; keeps the last value for the frame between removal and unmount.
  const [inst, setInst] = createSignal<PropertyInstance>(instanceOf(app, clipId, id)!)
  const sync = app.doc.onChange.on(() => {
    const next = instanceOf(app, clipId, id)
    if (next && next !== inst()) setInst(next)
  })
  onCleanup(() => sync.dispose())

  const contribs = useRegistry(app.registries.properties)
  const contrib = createMemo(() => (contribs(), app.registries.properties.get(inst().type)))
  const selected = useValue(app.selection.property)
  const collapsed = () => isCollapsed(id)

  const [summaryText, setSummary] = createSignal('')
  const readSummary = () => {
    const c = contrib()
    const i = instanceOf(app, clipId, id)
    if (!c?.summary || !i) return setSummary('')
    try {
      setSummary(c.summary(evaluateProperty(app.registries, c, i, app.edit.localTime(clipId))))
    } catch {
      setSummary('')
    }
  }
  readSummary()
  onCleanup(subscribeEditing(app, readSummary, () => Object.values(instanceOf(app, clipId, id)?.params ?? {}).some(isAnimated)))

  const select = () => app.selection.property.set(id)

  const menu = (anchor: Anchor) =>
    openMenu(anchor, [
      { label: 'Copy property', icon: 'copy', run: () => app.run('edit.copyProperty', clipId, id) },
      { label: 'Paste property', icon: 'clipboard-paste', run: () => app.run('edit.pasteProperty', clipId) },
      { separator: true },
      { label: 'Reset to default', icon: 'rotate-ccw', run: () => app.edit.resetProperty(clipId, id) },
      { separator: true },
      { label: 'Move up', icon: 'arrow-up', disabled: props.index() === 0, run: () => app.edit.moveProperty(clipId, id, props.index() - 1) },
      { label: 'Move down', icon: 'arrow-down', disabled: props.index() >= props.count() - 1, run: () => app.edit.moveProperty(clipId, id, props.index() + 1) },
      { separator: true },
      { label: 'Remove', icon: 'trash-2', danger: true, run: () => app.edit.removeProperty(clipId, id) }
    ])

  const headerDown = (e: PointerEvent) => {
    select()
    if ((e.target as HTMLElement).closest('button, .toggle')) return
    props.onDragStart(e, id)
  }

  return (
    <section
      class="ins-card"
      classList={{ collapsed: collapsed(), disabled: !inst().enabled, selected: selected() === id, dragging: props.dragging() }}
      data-pid={id}
      onPointerDown={select}
    >
      <header
        class="ins-card-head"
        onPointerDown={headerDown}
        onClick={() => setCardCollapsed(id, !collapsed())}
        onContextMenu={(e) => {
          e.preventDefault()
          select()
          menu({ x: e.clientX, y: e.clientY })
        }}
      >
        <Icon name="chevron-down" size={13} class="ins-chev" />
        <Icon name={contrib()?.icon ?? 'circle-help'} size={14} class="ins-card-icon" />
        <span class="ins-card-name">{contrib()?.name ?? inst().type}</span>
        <Show when={collapsed() && summaryText()}>
          <span class="ins-card-summary tnum">{summaryText()}</span>
        </Show>
        <span class="ins-card-fill" />
        <Toggle
          size="sm"
          value={inst().enabled}
          tip={inst().enabled ? 'Disable' : 'Enable'}
          onChange={(v) => app.edit.setPropertyEnabled(clipId, id, v)}
        />
        <IconButton
          icon="ellipsis"
          size="sm"
          tip="More"
          onClick={(e) => {
            e.stopPropagation()
            menu(e.currentTarget)
          }}
        />
      </header>
      <Show when={!collapsed()}>
        <div class="ins-card-body">
          <Show
            when={contrib()}
            keyed
            fallback={
              <div class="ins-missing">
                Plugin for “{inst().type}” isn’t loaded. Its data is kept.
              </div>
            }
          >
            {(c) => (
              <Show
                when={c.editor}
                fallback={<For each={c.params.filter((d) => !d.hidden)}>{(def) => <ParamRow app={app} clipId={clipId} propId={id} def={def} />}</For>}
              >
                <MountHost class="ins-custom" mount={c.editor!} ctx={makePropertyContext(app, clipId, id, c)} />
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}
