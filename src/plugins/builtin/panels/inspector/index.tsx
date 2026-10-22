import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { definePlugin, type PanelContext } from '@core/plugin-api'
import { findClip, type Clip, type Id } from '@shared/project'
import { shallowArrayEqual } from '@core/value'
import { expandLinked } from '@core/timeline-ops'
import { Button, Empty, IconButton, Segmented } from '@ui/kit'
import { Icon } from '@ui/icon'
import { useProject, useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { AddPropertyAnchor } from './AddProperty'
import { ClipHeader } from './ClipHeader'
import { MediaInfo } from './MediaInfo'
import { PropertyCard } from './PropertyCard'
import './inspector.css'
import { ClipSections, SubjectSection, useSubjectSection } from './Sections'

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
          <ClipSections app={app} clipId={clipId} />
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

/**
 * The clip the inspector edits: the selection itself, or — when the selection is exactly one link
 * group (video + its audio) — the picked partner, visual clips first.
 */
function useFocus(app: CascadeAPI) {
  const clips = useValue(app.selection.clips)
  const project = useProject(app)
  const [pick, setPick] = createSignal<Id | null>(null)
  const group = createMemo(
    () => {
      project()
      const ids = clips()
      if (ids.length < 2) return [] as Id[]
      const tl = app.timeline()
      const linked = expandLinked(tl, [ids[0]])
      if (linked.size !== ids.length || !ids.every((id) => linked.has(id))) return [] as Id[]
      const audio = (id: Id) => (findClip(tl, id)?.track.kind === 'audio' ? 1 : 0)
      return [...ids].sort((a, b) => audio(a) - audio(b))
    },
    [] as Id[],
    { equals: shallowArrayEqual }
  )
  const focused = createMemo(() => {
    if (clips().length === 1) return clips()[0]
    const g = group()
    if (!g.length) return null
    const p = pick()
    return p && g.includes(p) ? p : g[0]
  })
  return { clips, group, focused, setPick }
}

function LinkSwitch(props: { app: CascadeAPI; group: Id[]; value: Id; onChange: (id: Id) => void }) {
  const project = useProject(props.app)
  const options = createMemo(() => {
    project()
    const tl = props.app.timeline()
    return props.group.map((id) => {
      const f = findClip(tl, id)
      const mt = f && props.app.registries.mediaTypes.get(f.clip.type)
      return { value: id, label: f?.track.kind === 'audio' ? 'Audio' : (mt?.name ?? 'Clip'), icon: f?.track.kind === 'audio' ? 'audio-lines' : (mt?.icon ?? 'film') }
    })
  })
  return (
    <div class="ins-link-switch">
      <Icon name="link-2" size={12} />
      <span>Linked</span>
      <Segmented value={props.value} options={options()} onChange={props.onChange} />
    </div>
  )
}

function Inspector(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const { clips, group, focused, setPick } = useFocus(app)
  const media = useValue(app.selection.media)
  const section = useSubjectSection(app)
  return (
    <div class="ins">
      <Switch>
        <Match when={focused()} keyed>
          {(id) => (
            <>
              <Show when={group().length > 1}>
                <LinkSwitch app={app} group={group()} value={id} onChange={setPick} />
              </Show>
              <ClipInspector app={app} clipId={id} />
            </>
          )}
        </Match>
        <Match when={clips().length > 1}>
          <MultiClip app={app} />
        </Match>
        <Match when={section()} keyed>{(s) => <SubjectSection app={app} section={s} />}</Match>
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
  const { focused } = useFocus(app)
  return (
    <AddPropertyAnchor app={app} clipId={focused} align="end">
      {(a) => <IconButton icon="plus" size="sm" tip="Add property" active={a.open} disabled={!focused()} onClick={(e) => a.toggle(e.currentTarget)} />}
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
