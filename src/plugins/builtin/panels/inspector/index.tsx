import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { definePlugin, type PanelContext } from '@core/plugin-api'
import { findClip, type Clip, type Id } from '@shared/project'
import { shallowArrayEqual } from '@core/value'
import { Button, Empty, IconButton } from '@ui/kit'
import { Icon } from '@ui/icon'
import { useProject, useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { AddPropertyAnchor } from './AddProperty'
import { ClipHeader } from './ClipHeader'
import { MediaInfo } from './MediaInfo'
import { PropertyCard } from './PropertyCard'
import './inspector.css'

function MultiClip(props: { app: CascadeAPI }) {
  const app = props.app
  const ids = useValue(app.selection.clips)
  const project = useProject(app)
  const linked = createMemo(() => {
    project()
    const tl = app.timeline()
    return ids().some((id) => !!findClip(tl, id)?.clip.linkId)
  })
  return (
    <div class="ins-multi">
      <div class="ins-multi-badge tnum">{ids().length}</div>
      <div class="ins-multi-title">{ids().length} clips selected</div>
      <div class="ins-multi-hint">Select a single clip to edit its properties.</div>
      <div class="ins-multi-actions">
        <Button icon="copy" size="sm" onClick={() => app.edit.duplicateClips(ids())}>
          Duplicate
        </Button>
        <Button icon="unlink" size="sm" disabled={!linked()} onClick={() => app.edit.unlink(ids())}>
          Unlink
        </Button>
        <Button icon="trash-2" size="sm" variant="danger" onClick={() => app.edit.deleteClips(ids())}>
          Delete
        </Button>
      </div>
    </div>
  )
}

function ClipInspector(props: { app: CascadeAPI; clipId: Id }) {
  const { app, clipId } = props
  const project = useProject(app)
  const clip = createMemo<Clip | undefined>(() => (project(), findClip(app.timeline(), clipId)?.clip))
  // Cards are keyed by instance id, so editing a param never remounts a card (or its editors).
  const ids = createMemo(() => clip()?.properties.map((p) => p.id) ?? [], [] as Id[], { equals: shallowArrayEqual })

  let list!: HTMLDivElement
  let scroller!: HTMLDivElement
  const [dragId, setDragId] = createSignal<Id | null>(null)
  const [dropY, setDropY] = createSignal<number | null>(null)

  const startDrag = (e: PointerEvent, id: Id) => {
    if (e.button !== 0) return
    const startY = e.clientY
    let active = false
    let target = -1
    let lastY = startY
    let raf = 0

    const layout = () => {
      const others = [...list.querySelectorAll<HTMLElement>(':scope > .ins-card')].filter((c) => c.dataset.pid !== id)
      let idx = 0
      for (const c of others) {
        const r = c.getBoundingClientRect()
        if (lastY > r.top + r.height / 2) idx++
      }
      target = idx
      const lr = list.getBoundingClientRect()
      const y = idx < others.length ? others[idx].getBoundingClientRect().top - lr.top - 3 : (others[others.length - 1]?.getBoundingClientRect().bottom ?? lr.top) - lr.top + 3
      setDropY(y)
    }
    const autoscroll = () => {
      const r = scroller.getBoundingClientRect()
      const edge = 36
      if (lastY < r.top + edge) scroller.scrollTop -= 8
      else if (lastY > r.bottom - edge) scroller.scrollTop += 8
      layout()
      raf = requestAnimationFrame(autoscroll)
    }
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 5) return
        active = true
        setDragId(id)
        document.body.classList.add('ins-reordering')
        raf = requestAnimationFrame(autoscroll)
      }
      layout()
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      document.body.classList.remove('ins-reordering')
      if (!active) return
      setDragId(null)
      setDropY(null)
      // the click that ends a drag must not toggle the card
      window.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true })
      if (commit && target >= 0 && target !== ids().indexOf(id)) app.edit.moveProperty(clipId, id, target)
    }
    const up = () => finish(true)
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key, true)
  }

  return (
    <Show when={clip()} fallback={<Empty icon="mouse-pointer-click" title="Clip not found" />}>
      {(c) => (
        <div class="ins-scroll" ref={scroller}>
          <ClipHeader app={app} clip={c()} />
          <div class="ins-list" ref={list}>
            <For each={ids()}>
              {(id) => (
                <PropertyCard
                  app={app}
                  clipId={clipId}
                  id={id}
                  index={() => ids().indexOf(id)}
                  count={() => ids().length}
                  dragging={() => dragId() === id}
                  onDragStart={startDrag}
                />
              )}
            </For>
            <Show when={dropY() !== null}>
              <div class="ins-drop" style={{ top: `${dropY()}px` }} />
            </Show>
            <Show when={!ids().length}>
              <div class="ins-noprops">
                <Icon name="layers" size={18} />
                <span>No properties yet</span>
              </div>
            </Show>
          </div>
          <div class="ins-foot">
            <AddPropertyAnchor app={app} clipId={() => clipId}>
              {(a) => (
                <button class="ins-add-btn" classList={{ open: a.open }} onClick={(e) => a.toggle(e.currentTarget)}>
                  <Icon name="plus" size={14} />
                  <span>Add property</span>
                </button>
              )}
            </AddPropertyAnchor>
          </div>
        </div>
      )}
    </Show>
  )
}

function Inspector(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const clips = useValue(app.selection.clips)
  const media = useValue(app.selection.media)
  return (
    <div class="ins">
      <Switch>
        <Match when={clips().length === 1 && clips()[0]} keyed>
          {(id) => <ClipInspector app={app} clipId={id} />}
        </Match>
        <Match when={clips().length > 1}>
          <MultiClip app={app} />
        </Match>
        <Match when={media().length > 0}>
          <MediaInfo app={app} />
        </Match>
        <Match when={true}>
          <Empty icon="sliders-horizontal" title="No clip selected" hint="Select a clip on the timeline to edit its properties and keyframes." />
        </Match>
      </Switch>
    </div>
  )
}

function HeaderActions(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const clips = useValue(app.selection.clips)
  const clipId = () => (clips().length === 1 ? clips()[0] : null)
  return (
    <AddPropertyAnchor app={app} clipId={clipId} align="end">
      {(a) => <IconButton icon="plus" size="sm" tip="Add property" active={a.open} disabled={!clipId()} onClick={(e) => a.toggle(e.currentTarget)} />}
    </AddPropertyAnchor>
  )
}

/** The Clip inspector: header, stacked property cards with keyframe controls, and an add-property picker. */
export const inspectorPlugin = definePlugin({
  id: 'cascade.panels.inspector',
  name: 'Inspector',
  activate(ctx) {
    ctx.panels.register({
      id: 'inspector',
      title: 'Clip',
      icon: 'sliders-horizontal',
      region: 'top',
      order: 1,
      mount: solidMount(Inspector),
      actions: solidMount(HeaderActions)
    })
  }
})
