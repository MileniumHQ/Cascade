import { createMemo, onCleanup, onMount, Show, type Accessor } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { MediaTypeContribution } from '@core/plugin-api'
import type { Id, MediaItem, Project } from '@shared/project'
import { Icon, iconMarkup } from '@ui/icon'
import { formatDuration, mediaDetail, waveformGlyph } from './format'
import { GeneratorTile } from './tiles'
import type { ViewMode } from './state'

/** Everything an item needs from the panel, so items stay small and keyed by id. */
export interface PanelApi {
  app: CascadeAPI
  project: Accessor<Project>
  mode: Accessor<ViewMode>
  selected: Accessor<Set<Id>>
  usage: Accessor<Map<Id, number>>
  renaming: Accessor<Id | null>
  /** Run `cb` once when `el` first scrolls near the viewport. */
  observe(el: Element, cb: () => void): () => void
  select(id: Id, e: MouseEvent): void
  addToTimeline(ids: Id[]): void
  contextMenu(e: MouseEvent, id: Id): void
  commitRename(id: Id, name: string | null): void
  dragIds(id: Id): Id[]
}

export function setDragImage(e: DragEvent, icon: string, label: string, color: string) {
  const pill = document.createElement('div')
  pill.className = 'sc-dragimg'
  pill.style.setProperty('--tc', color)
  pill.innerHTML = `<span class="sc-dragimg-icon">${iconMarkup(icon, 2.2)}</span><span class="sc-dragimg-label"></span>`
  pill.querySelector('.sc-dragimg-label')!.textContent = label
  document.body.appendChild(pill)
  e.dataTransfer?.setDragImage(pill, 14, 14)
  setTimeout(() => pill.remove(), 0)
}

/** Poster/thumbnail area. The media type mounts into a surface once the item is (nearly) visible. */
function Thumb(props: { media: Accessor<MediaItem>; mt: Accessor<MediaTypeContribution | undefined>; api: PanelApi }) {
  let el!: HTMLDivElement
  const generator = createMemo(() => {
    const g = props.media().data?.generator
    return typeof g === 'string' ? props.api.app.registries.generators.get(g) : undefined
  })
  const hasThumb = () => !!props.mt()?.thumbnail
  onMount(() => {
    if (!hasThumb()) return
    let cleanup: void | (() => void)
    let surface: HTMLElement | undefined
    const stop = props.api.observe(el, () => {
      const mt = props.mt()
      surface = document.createElement('div')
      surface.className = 'sc-surface'
      el.appendChild(surface)
      try {
        cleanup = mt?.thumbnail?.(surface, { media: props.media(), app: props.api.app })
      } catch (err) {
        console.warn('[sources] thumbnail failed', err)
      }
      if (surface.classList.contains('media-thumb-audio')) {
        const color = getComputedStyle(el).getPropertyValue('--tc').trim() || '#52c48e'
        surface.style.backgroundImage = waveformGlyph(props.media().id, color)
      }
    })
    onCleanup(() => {
      stop()
      try {
        cleanup?.()
      } catch {}
      surface?.remove()
    })
  })
  return (
    <div ref={el} class="sc-thumb" classList={{ 'sc-thumb-pending': hasThumb() }}>
      <Show
        when={!hasThumb() && generator()}
        fallback={
          <span class="sc-thumb-icon">
            <Icon name={props.mt()?.icon ?? 'file-question'} size={22} />
          </span>
        }
      >
        <GeneratorTile media={props.media()} generator={generator()!} app={props.api.app} />
      </Show>
    </div>
  )
}

export function MediaCard(props: { id: Id; api: PanelApi }) {
  const { api } = props
  const media = createMemo(() => api.project().media[props.id])
  const mt = createMemo(() => api.app.registries.mediaTypes.get(media()?.type ?? ''))
  const selected = createMemo(() => api.selected().has(props.id))
  const uses = createMemo(() => api.usage().get(props.id) ?? 0)
  const duration = createMemo(() => {
    const m = media()
    return m && mt()?.timeBased && m.meta.duration ? formatDuration(m.meta.duration) : ''
  })
  const generatorName = () => {
    const g = media()?.data?.generator
    return typeof g === 'string' ? api.app.registries.generators.get(g)?.name : undefined
  }
  const detail = createMemo(() => (media() ? mediaDetail(media()!, generatorName() ?? mt()?.name ?? media()!.type) : ''))
  const color = () => mt()?.color ?? 'var(--muted)'
  const renaming = () => api.renaming() === props.id
  let input: HTMLInputElement | undefined

  const usedTip = () => `Used ${uses()}× in the timeline`
  const Used = () => (
    <Show when={uses() > 0}>
      <span class="sc-used tnum" data-tip={usedTip()}>
        <Icon name="gantt-chart" size={10} stroke={2.2} />
        {uses()}
      </span>
    </Show>
  )

  return (
    <Show when={media()}>
      <div
        class="sc-item"
        classList={{ selected: selected(), renaming: renaming(), unused: uses() === 0 }}
        data-id={props.id}
        style={{ '--tc': color() }}
        draggable={!renaming()}
        onClick={(e) => api.select(props.id, e)}
        onDblClick={(e) => {
          if (renaming() || (e.target as HTMLElement).closest('input')) return
          api.addToTimeline([props.id])
        }}
        onContextMenu={(e) => api.contextMenu(e, props.id)}
        onDragStart={(e) => {
          if (!e.dataTransfer) return
          e.dataTransfer.setData('application/x-cascade-media', props.id)
          e.dataTransfer.setData('text/plain', media()!.name)
          e.dataTransfer.effectAllowed = 'copy'
          setDragImage(e, mt()?.icon ?? 'file', media()!.name, color())
        }}
      >
        <div class="sc-thumbwrap">
          <Thumb media={media as Accessor<MediaItem>} mt={mt} api={api} />
          <span class="sc-typechip">
            <Icon name={mt()?.icon ?? 'file-question'} size={10} stroke={2.2} />
          </span>
          <Show when={duration()}>
            <span class="sc-dur sc-dur-overlay tnum">{duration()}</span>
          </Show>
          <span class="sc-used-overlay">
            <Used />
          </span>
        </div>
        <div class="sc-meta">
          <Show
            when={renaming()}
            fallback={
              <div class="sc-name" data-tip={api.mode() === 'grid' ? media()!.name : undefined}>
                {media()!.name}
              </div>
            }
          >
            <input
              ref={(el) => {
                input = el
                queueMicrotask(() => {
                  el.focus()
                  const dot = media()!.name.lastIndexOf('.')
                  el.setSelectionRange(0, dot > 0 && !media()!.data?.generator ? dot : el.value.length)
                })
              }}
              class="sc-rename"
              value={media()!.name}
              onClick={(e) => e.stopPropagation()}
              onDblClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') api.commitRename(props.id, input!.value)
                else if (e.key === 'Escape') api.commitRename(props.id, null)
              }}
              onBlur={() => api.renaming() === props.id && api.commitRename(props.id, input!.value)}
            />
          </Show>
          <div class="sc-sub">{detail()}</div>
        </div>
        <div class="sc-aside">
          <Show when={duration()}>
            <span class="sc-dur tnum">{duration()}</span>
          </Show>
          <Used />
        </div>
      </div>
    </Show>
  )
}
