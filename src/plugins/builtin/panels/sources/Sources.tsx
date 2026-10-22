import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import type { GeneratorContribution, PanelContext } from '@core/plugin-api'
import { clipEnd, findClip, type Id, type Project, type Timeline } from '@shared/project'
import { Icon } from '@ui/icon'
import { Button, IconButton, openContextMenu, openMenu, Segmented, type MenuItem } from '@ui/kit'
import { useProject, useRegistry, useValue } from '@ui/reactive'
import { MediaCard, setDragImage, type PanelApi } from './Item'
import { Breadcrumb, dropTarget, FolderRow, type FolderApi } from './Folder'
import { deleteBinFolder, moveBinFolder, moveMediaToFolder, newFolder, renameBinFolder } from './bin'
import { BIN_KEY, childFolders, folderById, folderOf, mediaIn, pathTo, readBin } from './folders'
import { compareNames } from './format'
import {
  createOpen,
  currentFolder,
  renamingFolder,
  selectedFolder,
  setCurrentFolder,
  setRenamingFolder,
  setSelectedFolder,
  importState,
  selectMedia,
  setCreateOpen,
  setSortDesc,
  setSortKey,
  setTypeFilter,
  sortDesc,
  sortKey,
  SORT_KEYS,
  trackImport,
  typeFilter,
  viewMode,
  type TypeFilter
} from './state'

// ───────────────────────────── helpers ─────────────────────────────

const usageCache = new WeakMap<Timeline, Map<Id, number>>()

/** How many clips reference each media item, across every timeline (cached per immutable timeline). */
function computeUsage(p: Project): Map<Id, number> {
  const total = new Map<Id, number>()
  for (const tl of Object.values(p.timelines)) {
    let local = usageCache.get(tl)
    if (!local) {
      local = new Map()
      for (const tr of tl.tracks) for (const c of tr.clips) if (c.mediaId) local.set(c.mediaId, (local.get(c.mediaId) ?? 0) + 1)
      usageCache.set(tl, local)
    }
    for (const [id, n] of local) total.set(id, (total.get(id) ?? 0) + n)
  }
  return total
}

const sameIds = (a: Id[], b: Id[]) => a.length === b.length && a.every((v, i) => v === b[i])

const FILTERS: { value: TypeFilter; label?: string; icon?: string; tip: string }[] = [
  { value: 'all', label: 'All', tip: 'All sources' },
  { value: 'video', icon: 'film', tip: 'Video' },
  { value: 'audio', icon: 'audio-lines', tip: 'Audio' },
  { value: 'image', icon: 'image', tip: 'Images' },
  { value: 'element', icon: 'shapes', tip: 'Elements (text, shapes, solids)' }
]

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

// ───────────────────────────── panel ─────────────────────────────

export function Sources(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const project = useProject(app)
  const selection = useValue(app.selection.media)
  const generators = useRegistry(app.registries.generators)
  /** Create-list entries by category; uncategorized ones come first. */
  const generatorGroups = createMemo(() => {
    const groups = new Map<string, GeneratorContribution[]>()
    for (const g of generators()) groups.set(g.category ?? '', [...(groups.get(g.category ?? '') ?? []), g])
    return [...groups.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0))
  })
  const [query, setQuery] = createSignal('')
  const [renaming, setRenaming] = createSignal<Id | null>(null)
  const [dragging, setDragging] = createSignal(false)
  let root!: HTMLDivElement
  let scroller!: HTMLDivElement
  let itemsEl: HTMLDivElement | undefined
  let anchor: Id | null = null
  let dragDepth = 0

  const selected = createMemo(() => new Set(selection()))
  const usage = createMemo(() => computeUsage(project()))
  const empty = () => project().mediaOrder.length === 0
  const importing = () => importState().jobs > 0

  const bin = createMemo(() => readBin(project().pluginData[BIN_KEY]))
  /** Folder being shown; a stale id (deleted, undone, other project) falls back to the root. */
  const folder = createMemo(() => (folderById(bin(), currentFolder()) ? currentFolder() : null))
  const searching = () => query().trim() !== ''
  const folders = createMemo(() => (searching() ? [] : childFolders(bin(), folder())))
  const crumbs = createMemo(() => pathTo(bin(), folder()))

  const ids = createMemo<Id[]>(
    () => {
      const p = project()
      const q = query().trim().toLowerCase()
      const f = typeFilter()
      // Search looks through every folder; browsing shows the current one.
      const visible = q ? p.mediaOrder : mediaIn(bin(), folder(), p.mediaOrder)
      let list = visible.map((id) => ({ m: p.media[id], i: p.mediaOrder.indexOf(id) })).filter((x) => x.m)
      if (f !== 'all') list = list.filter((x) => x.m.type === f)
      if (q) list = list.filter((x) => x.m.name.toLowerCase().includes(q))
      const dir = sortDesc() ? -1 : 1
      const key = sortKey()
      list.sort((a, b) => {
        let c = 0
        if (key === 'name') c = compareNames(a.m.name, b.m.name)
        else if (key === 'type') c = compareNames(a.m.type, b.m.type) || compareNames(a.m.name, b.m.name)
        else if (key === 'duration') c = (a.m.meta.duration ?? 0) - (b.m.meta.duration ?? 0)
        return (c || a.i - b.i) * dir
      })
      return list.map((x) => x.m.id)
    },
    [],
    { equals: sameIds }
  )

  // Thumbnails mount lazily: one observer shared by every item.
  const watchers = new Map<Element, () => void>()
  let io: IntersectionObserver | undefined
  onMount(() => {
    io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const cb = watchers.get(en.target)
          watchers.delete(en.target)
          io?.unobserve(en.target)
          cb?.()
        }
      },
      { root: scroller, rootMargin: '240px 0px' }
    )
    onCleanup(() => io?.disconnect())
  })
  const observe = (el: Element, cb: () => void) => {
    watchers.set(el, cb)
    io?.observe(el)
    return () => {
      watchers.delete(el)
      io?.unobserve(el)
    }
  }

  // A different project has different folders.
  createEffect(
    on(
      () => project().id,
      () => {
        setCurrentFolder(null)
        setSelectedFolder(null)
        setRenamingFolder(null)
      },
      { defer: true }
    )
  )

  const find = (id: Id) => scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)

  // Keep the newest selection in view (imports, keyboard navigation, timeline → bin).
  createEffect(
    on(selection, (sel) => {
      const last = sel[sel.length - 1]
      if (!last) return
      // Selecting from elsewhere (timeline, imports) must not leave the item hidden in another folder.
      if (!searching() && folderOf(bin(), last) !== folder()) setCurrentFolder(folderOf(bin(), last))
      requestAnimationFrame(() => find(last)?.scrollIntoView({ block: 'nearest' }))
    })
  )

  // ─── actions ───

  const select = (id: Id, e: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) => {
    const order = ids()
    const cur = selection()
    let next: Id[]
    if (e.shiftKey && anchor && order.includes(anchor)) {
      const a = order.indexOf(anchor)
      const b = order.indexOf(id)
      const range = a <= b ? order.slice(a, b + 1) : order.slice(b, a + 1).reverse()
      next = e.ctrlKey || e.metaKey ? [...cur.filter((x) => !range.includes(x)), ...range] : range
    } else if (e.ctrlKey || e.metaKey) {
      next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      anchor = id
    } else {
      next = [id]
      anchor = id
    }
    setSelectedFolder(null)
    selectMedia(app, next)
    root.focus({ preventScroll: true })
  }

  // ─── folders ───

  const selectFolder = (id: Id) => {
    selectMedia(app, [])
    setSelectedFolder(id)
    root.focus({ preventScroll: true })
  }
  const openFolder = (id: Id | null) => {
    setCurrentFolder(id)
    setSelectedFolder(null)
    selectMedia(app, [])
  }
  const commitFolderRename = (id: Id, name: string | null) => {
    setRenamingFolder(null)
    root.focus({ preventScroll: true })
    const trimmed = name?.trim()
    if (trimmed && trimmed !== folderById(bin(), id)?.name) renameBinFolder(app, id, trimmed)
  }
  const folderMenu = (e: MouseEvent, id: Id) => {
    selectFolder(id)
    openContextMenu(e, [
      { label: 'Open', icon: 'folder-open', shortcut: 'Enter', run: () => openFolder(id) },
      { label: 'New folder inside', icon: 'folder', run: () => newFolder(app, [], id) },
      { label: 'Rename', icon: 'pencil', shortcut: 'F2', run: () => setRenamingFolder(id) },
      { separator: true },
      { label: 'Delete folder', icon: 'trash-2', shortcut: 'Del', danger: true, run: () => deleteBinFolder(app, id) }
    ])
  }
  const folderApi: FolderApi = {
    selected: selectedFolder,
    renaming: renamingFolder,
    count: (id) => mediaIn(bin(), id, project().mediaOrder, true).length,
    open: openFolder,
    select: selectFolder,
    contextMenu: folderMenu,
    commitRename: commitFolderRename,
    dropMedia: (list, to) => moveMediaToFolder(app, list.filter((m) => project().media[m]), to),
    dropFolder: (id, to) => moveBinFolder(app, id, to)
  }
  // Dropping on the empty part of the list moves things into the folder being shown.
  const listDrop = dropTarget(folderApi, folder)

  const addToTimeline = (list: Id[]) => {
    // Several items go end-to-end from the playhead instead of overwriting each other.
    let start = app.playback.time.get()
    for (const id of list) {
      const created = app.edit.addMediaToTimeline(id, { start })
      const tl = app.timeline()
      for (const cid of created) {
        const hit = findClip(tl, cid)
        if (hit) start = Math.max(start, clipEnd(hit.clip))
      }
    }
  }

  const removeMedia = async (list: Id[]) => {
    if (!list.length) return
    const used = list.reduce((n, id) => n + (usage().get(id) ?? 0), 0)
    if (used > 0 && app.host) {
      const what = list.length === 1 ? `“${project().media[list[0]]?.name}”` : `${list.length} items`
      const choice = await app.host.dialog.confirm({
        message: `Remove ${what} from the project?`,
        detail: `${used} clip${used > 1 ? 's' : ''} in the timeline use${used > 1 ? '' : 's'} this media and will be removed too. You can undo this.`,
        buttons: ['Remove', 'Cancel']
      })
      if (choice !== 0) return
    }
    app.edit.removeMedia(list)
    const gone = new Set(list)
    app.selection.media.set(app.selection.media.get().filter((id) => !gone.has(id)))
  }

  const startRename = (id: Id) => {
    select(id, { shiftKey: false, ctrlKey: false, metaKey: false })
    setRenaming(id)
  }
  const commitRename = (id: Id, name: string | null) => {
    setRenaming(null)
    root.focus({ preventScroll: true })
    const trimmed = name?.trim()
    if (trimmed && trimmed !== project().media[id]?.name) app.edit.renameMedia(id, trimmed)
  }

  const reveal = (id: Id) => {
    const path = project().media[id]?.path
    if (path) app.host?.shell.showItemInFolder(path)
  }

  const contextMenu = (e: MouseEvent, id: Id) => {
    if (!selected().has(id)) select(id, { shiftKey: false, ctrlKey: false, metaKey: false })
    const sel = app.selection.media.get()
    const multi = sel.length > 1
    const m = project().media[id]
    const extra: MenuItem[] = app.registries.menus
      .all()
      .filter((it) => it.location === 'source/context' && (!it.when || it.when(app, m)))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((it) => ({ label: it.label, icon: it.icon, shortcut: it.shortcut, run: () => void app.run(it.command, id) }))
    openContextMenu(e, [
      { label: multi ? `Add ${sel.length} to timeline` : 'Add to timeline', icon: 'plus', shortcut: 'Enter', run: () => addToTimeline(sel) },
      { label: 'Rename', icon: 'pencil', shortcut: 'F2', disabled: multi, run: () => startRename(id) },
      { label: 'Reveal in file manager', icon: 'folder-search', disabled: !m?.path, run: () => reveal(id) },
      { separator: true },
      { label: 'New folder with selection', icon: 'folder', run: () => newFolder(app, sel) },
      ...(folder() !== null ? [{ label: 'Move out of folder', icon: 'arrow-up', run: () => moveMediaToFolder(app, sel, folderById(bin(), folder())?.parent ?? null) }] : []),
      ...(extra.length ? [{ separator: true }, ...extra] : []),
      { separator: true },
      { label: multi ? `Remove ${sel.length} from project` : 'Remove from project', icon: 'trash-2', shortcut: 'Del', danger: true, run: () => void removeMedia(sel) }
    ])
  }

  const blankMenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.sc-item, .sc-gen, .sc-folder')) return
    openContextMenu(e, [
      { label: 'Import media…', icon: 'import', shortcut: 'Ctrl+I', run: () => void importDialog() },
      { label: 'New folder', icon: 'folder', run: () => newFolder(app) },
      { label: 'Select all', icon: 'check-check', shortcut: 'Ctrl+A', disabled: !ids().length, run: () => selectMedia(app, ids()) }
    ])
  }

  const importDialog = () => trackImport(app, () => app.run('media.import'))

  const create = (genId: string) => {
    const id = app.edit.addGenerated(genId)
    if (!id) return
    // Make sure the new source isn't hidden by the current filter/search.
    if (!ids().includes(id)) {
      setQuery('')
      setTypeFilter('all')
    }
    anchor = id
    selectMedia(app, [id])
  }

  const api: PanelApi = {
    app,
    project,
    mode: viewMode,
    selected,
    usage,
    renaming,
    observe,
    select,
    addToTimeline,
    contextMenu,
    commitRename,
    dragIds: (id) => (selected().has(id) ? selection() : [id])
  }

  // ─── keyboard ───

  const columns = () => {
    if (viewMode() !== 'grid' || !itemsEl) return 1
    return Math.max(1, getComputedStyle(itemsEl).gridTemplateColumns.split(' ').length)
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      const mod = e.ctrlKey || e.metaKey
      const sel = app.selection.media.get()
      const folderSel = selectedFolder()
      let handled = true
      if (folderSel && !mod && ['F2', 'Delete', 'Backspace', 'Enter', 'Escape'].includes(e.key)) {
        if (e.key === 'F2') setRenamingFolder(folderSel)
        else if (e.key === 'Enter') openFolder(folderSel)
        else if (e.key === 'Escape') setSelectedFolder(null)
        else deleteBinFolder(app, folderSel)
      } else if (e.altKey && e.key === 'ArrowUp') openFolder(folderById(bin(), folder())?.parent ?? null)
      else if (e.key === 'Backspace' && !sel.length && folder() !== null) openFolder(folderById(bin(), folder())?.parent ?? null)
      else if (e.key === 'Delete' || e.key === 'Backspace') void removeMedia(sel)
      else if (e.key === 'F2') sel.length && startRename(sel[sel.length - 1])
      else if (e.key === 'Enter') sel.length && addToTimeline(sel)
      else if (mod && e.key.toLowerCase() === 'a') selectMedia(app, ids())
      else if (e.key === 'Escape') selectMedia(app, [])
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !mod) {
        const order = ids()
        if (!order.length) return
        const cur = order.indexOf(sel[sel.length - 1])
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowUp' ? -1 : 1) * columns()
        const to = cur < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, cur + step))
        select(order[to], { shiftKey: e.shiftKey, ctrlKey: false, metaKey: false })
      } else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    root.addEventListener('keydown', onKey)
    onCleanup(() => root.removeEventListener('keydown', onKey))
  })

  // ─── OS file drop ───

  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    setDragging(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    if (--dragDepth <= 0) {
      dragDepth = 0
      setDragging(false)
    }
  }
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    setDragging(false)
    const host = app.host
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!host || !files.length) return
    const paths = files.map((f) => host.fs.pathForFile(f)).filter(Boolean)
    if (paths.length) void trackImport(app, () => app.edit.importFiles(paths), paths.length)
  }

  const sortMenu = (anchorEl: HTMLElement) =>
    openMenu(anchorEl, [
      ...SORT_KEYS.map((s) => ({ label: s.label, checked: sortKey() === s.value, run: () => setSortKey(s.value) })),
      { separator: true },
      { label: 'Ascending', icon: 'arrow-up-narrow-wide', checked: !sortDesc(), run: () => setSortDesc(false) },
      { label: 'Descending', icon: 'arrow-down-wide-narrow', checked: sortDesc(), run: () => setSortDesc(true) }
    ])

  const skeletons = () => (importing() ? Math.min(12, Math.max(1, importState().files)) : 0)

  return (
    <div
      ref={root}
      class="sc"
      tabindex={0}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div class="sc-toolbar">
        <div class="sc-row">
          <div class="textfield sc-search">
            <Icon name="search" size={14} class="tf-icon" />
            <input
              value={query()}
              placeholder="Search sources"
              spellcheck={false}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') {
                  setQuery('')
                  e.currentTarget.blur()
                }
              }}
            />
            <Show when={query()}>
              <button class="sc-clear" onClick={() => setQuery('')} aria-label="Clear search">
                <Icon name="x" size={12} />
              </button>
            </Show>
          </div>
          <IconButton
            icon={sortDesc() ? 'arrow-down-wide-narrow' : 'arrow-up-narrow-wide'}
            tip={`Sort: ${SORT_KEYS.find((s) => s.value === sortKey())?.label}`}
            onClick={(e) => sortMenu(e.currentTarget)}
          />
        </div>
        <Segmented value={typeFilter()} options={FILTERS} onChange={setTypeFilter} />
      </div>

      <Show when={importing()}>
        <div class="sc-importing">
          <Icon name="loader-circle" size={13} class="sc-spin" />
          <span>{importState().files > 0 ? `Importing ${importState().files} file${importState().files > 1 ? 's' : ''}…` : 'Importing…'}</span>
          <i class="sc-importing-bar" />
        </div>
      </Show>

      <div
        ref={scroller}
        class="sc-scroll"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.sc-item, .sc-gen, .sc-folder, button, input')) {
            selectMedia(app, [])
            setSelectedFolder(null)
          }
        }}
        onContextMenu={blankMenu}
        {...listDrop}
      >
        <section class="sc-section">
          <button class="sc-section-head" onClick={() => setCreateOpen(!createOpen())}>
            <Icon name="chevron-right" size={12} class={`sc-chev ${createOpen() ? 'open' : ''}`} />
            <span>Create</span>
          </button>
          <Show when={createOpen()}>
            <div class="sc-gens">
              <For each={generatorGroups()}>
                {([category, list]) => (
                  <>
                    <Show when={category}>
                      <div class="sc-gens-title">{category}</div>
                    </Show>
                    <For each={list}>
                      {(g) => {
                        const color = () => app.registries.mediaTypes.get(g.mediaType)?.color ?? 'var(--clip-element)'
                        return (
                          <div
                            class="sc-gen"
                            style={{ '--tc': color() }}
                            draggable={true}
                            tabindex={-1}
                            onClick={() => create(g.id)}
                            onDragStart={(e) => {
                              if (!e.dataTransfer) return
                              e.dataTransfer.setData('application/x-cascade-generator', g.id)
                              e.dataTransfer.setData('text/plain', g.name)
                              e.dataTransfer.effectAllowed = 'copy'
                              setDragImage(e, g.icon, g.name, color())
                            }}
                          >
                            <span class="sc-gen-icon">
                              <Icon name={g.icon} size={16} />
                            </span>
                            <span class="sc-gen-text">
                              <span class="sc-gen-name">{g.name}</span>
                              <span class="sc-gen-desc">{g.description}</span>
                            </span>
                            <Icon name="plus" size={14} class="sc-gen-add" />
                          </div>
                        )
                      }}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
        </section>

        <section class="sc-section sc-section-media">
          <div class="sc-section-head sc-static">
            <span>Media</span>
            <span class="sc-count tnum">
              {ids().length === project().mediaOrder.length ? ids().length : `${ids().length} / ${project().mediaOrder.length}`}
            </span>
          </div>
          <Show when={crumbs().length > 0 && !searching()}>
            <Breadcrumb path={crumbs()} api={folderApi} />
          </Show>
          <Show when={folders().length > 0}>
            <div class="sc-folders" classList={{ list: viewMode() === 'list' }}>
              <For each={folders()}>{(f) => <FolderRow folder={f} api={folderApi} />}</For>
            </div>
          </Show>
          <Show
            when={!empty()}
            fallback={
              <Show
                when={!importing()}
                fallback={
                  <div class="sc-items grid">
                    <For each={Array.from({ length: skeletons() })}>{() => <Skeleton />}</For>
                  </div>
                }
              >
                <DropZone onImport={() => void importDialog()} />
              </Show>
            }
          >
            <Show
              when={ids().length || folders().length}
              fallback={
                <Show
                  when={searching() || typeFilter() !== 'all' || folder() === null}
                  fallback={<div class="sc-folder-empty">This folder is empty. Drag media here.</div>}
                >
                <div class="sc-nomatch">
                  <Icon name="search-x" size={18} />
                  <span>No sources match</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      setTypeFilter('all')
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
                </Show>
              }
            >
              <div ref={itemsEl} class="sc-items" classList={{ grid: viewMode() === 'grid', list: viewMode() === 'list' }}>
                <For each={ids()}>{(id) => <MediaCard id={id} api={api} />}</For>
                <For each={Array.from({ length: skeletons() })}>{() => <Skeleton />}</For>
              </div>
            </Show>
          </Show>
        </section>
      </div>

      <Show when={dragging()}>
        <div class="sc-drop-overlay">
          <div class="sc-drop-card">
            <Icon name="download" size={26} />
            <b>Drop to import</b>
            <span>Video, audio and images</span>
          </div>
        </div>
      </Show>
    </div>
  )
}

function Skeleton() {
  return (
    <div class="sc-item sc-skeleton">
      <div class="sc-thumbwrap" />
      <div class="sc-meta">
        <div class="sc-name" />
      </div>
    </div>
  )
}

function DropZone(props: { onImport: () => void }) {
  return (
    <div class="sc-dropzone">
      <div class="sc-dropzone-art">
        <Icon name="film" size={18} class="a" />
        <Icon name="download" size={26} class="b" />
        <Icon name="image" size={18} class="c" />
      </div>
      <div class="sc-dropzone-title">Drop your media here</div>
      <div class="sc-dropzone-hint">Video, audio and images — drag them in from your file manager, or browse.</div>
      <Button variant="primary" icon="import" onClick={props.onImport}>
        Import media
      </Button>
      <div class="sc-dropzone-sub">or create text, shapes and solids from above</div>
    </div>
  )
}
