import { For, Show, type JSX } from 'solid-js'
import type { Id } from '@shared/project'
import { Icon } from '@ui/icon'
import type { Folder } from './folders'

export const MEDIA_IDS_TYPE = 'application/x-cascade-media-ids'
export const FOLDER_TYPE = 'application/x-cascade-folder'

/** What the folder UI needs from the panel. */
export interface FolderApi {
  selected: () => Id | null
  renaming: () => Id | null
  /** Media items inside a folder, nested ones included. */
  count(id: Id): number
  open(id: Id | null): void
  select(id: Id): void
  contextMenu(e: MouseEvent, id: Id): void
  commitRename(id: Id, name: string | null): void
  dropMedia(ids: Id[], folder: Id | null): void
  dropFolder(id: Id, parent: Id | null): void
}

const accepts = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(MEDIA_IDS_TYPE) || e.dataTransfer.types.includes(FOLDER_TYPE))

/** Make `el` a place media and folders can be dropped (`folder` null = the root). */
export function dropTarget(api: FolderApi, folder: () => Id | null) {
  return {
    onDragOver(e: DragEvent) {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      e.currentTarget instanceof HTMLElement && e.currentTarget.classList.add('drop')
    },
    onDragLeave(e: DragEvent) {
      e.currentTarget instanceof HTMLElement && e.currentTarget.classList.remove('drop')
    },
    onDrop(e: DragEvent) {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget instanceof HTMLElement && e.currentTarget.classList.remove('drop')
      const media = e.dataTransfer?.getData(MEDIA_IDS_TYPE)
      const dragged = e.dataTransfer?.getData(FOLDER_TYPE)
      if (media) {
        try {
          const ids = JSON.parse(media) as Id[]
          if (Array.isArray(ids)) api.dropMedia(ids, folder())
        } catch {}
      } else if (dragged) api.dropFolder(dragged, folder())
    }
  }
}

export function FolderRow(props: { folder: Folder; api: FolderApi }) {
  const { api } = props
  const renaming = () => api.renaming() === props.folder.id
  let input: HTMLInputElement | undefined
  return (
    <div
      class="sc-folder"
      classList={{ selected: api.selected() === props.folder.id, renaming: renaming() }}
      data-folder={props.folder.id}
      draggable={!renaming()}
      onClick={(e) => {
        e.stopPropagation()
        api.select(props.folder.id)
      }}
      onDblClick={() => !renaming() && api.open(props.folder.id)}
      onContextMenu={(e) => api.contextMenu(e, props.folder.id)}
      onDragStart={(e) => {
        if (!e.dataTransfer) return
        e.dataTransfer.setData(FOLDER_TYPE, props.folder.id)
        e.dataTransfer.setData('text/plain', props.folder.name)
        e.dataTransfer.effectAllowed = 'move'
      }}
      {...dropTarget(api, () => props.folder.id)}
    >
      <Icon name="folder" size={15} class="sc-folder-icon" />
      <Show
        when={renaming()}
        fallback={
          <>
            <span class="sc-folder-name">{props.folder.name}</span>
            <span class="sc-folder-count tnum">{api.count(props.folder.id)}</span>
          </>
        }
      >
        <input
          ref={(el) => {
            input = el
            queueMicrotask(() => {
              el.focus()
              el.select()
            })
          }}
          class="sc-rename"
          value={props.folder.name}
          onClick={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') api.commitRename(props.folder.id, input!.value)
            else if (e.key === 'Escape') api.commitRename(props.folder.id, null)
          }}
          onBlur={() => api.renaming() === props.folder.id && api.commitRename(props.folder.id, input!.value)}
        />
      </Show>
    </div>
  )
}

/** Root › Folder › Subfolder; every crumb is also a drop target. */
export function Breadcrumb(props: { path: Folder[]; api: FolderApi }): JSX.Element {
  return (
    <nav class="sc-crumbs" aria-label="Folder">
      <button class="sc-crumb" classList={{ current: props.path.length === 0 }} onClick={() => props.api.open(null)} {...dropTarget(props.api, () => null)}>
        Media
      </button>
      <For each={props.path}>
        {(f, i) => (
          <>
            <Icon name="chevron-right" size={11} class="sc-crumb-sep" />
            <button class="sc-crumb" classList={{ current: i() === props.path.length - 1 }} onClick={() => props.api.open(f.id)} {...dropTarget(props.api, () => f.id)}>
              {f.name}
            </button>
          </>
        )}
      </For>
    </nav>
  )
}
