import { createSignal, type Accessor } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { Id } from '@shared/project'

const PREFIX = 'cascade.sources.'

/** A signal mirrored to localStorage (so the view survives restarts). */
function persisted<T>(key: string, fallback: T, valid: (v: unknown) => boolean): [Accessor<T>, (v: T) => void] {
  let init = fallback
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw !== null) {
      const v = JSON.parse(raw)
      if (valid(v)) init = v as T
    }
  } catch {}
  const [get, set] = createSignal<T>(init)
  return [
    get,
    (v) => {
      set(() => v)
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(v))
      } catch {}
    }
  ]
}

export type ViewMode = 'grid' | 'list'
export type SortKey = 'added' | 'name' | 'type' | 'duration'
export type TypeFilter = 'all' | 'video' | 'audio' | 'image' | 'element'

export const SORT_KEYS: { value: SortKey; label: string }[] = [
  { value: 'added', label: 'Date added' },
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'duration', label: 'Duration' }
]

export const [viewMode, setViewMode] = persisted<ViewMode>('view', 'grid', (v) => v === 'grid' || v === 'list')
export const [sortKey, setSortKey] = persisted<SortKey>('sort', 'added', (v) => SORT_KEYS.some((s) => s.value === v))
export const [sortDesc, setSortDesc] = persisted<boolean>('sortDesc', false, (v) => typeof v === 'boolean')
export const [typeFilter, setTypeFilter] = persisted<TypeFilter>('filter', 'all', (v) => ['all', 'video', 'audio', 'image', 'element'].includes(v as string))
export const [createOpen, setCreateOpen] = persisted<boolean>('createOpen', true, (v) => typeof v === 'boolean')

// ───────────────────────────── importing ─────────────────────────────

export interface ImportState {
  jobs: number
  /** Number of files in flight when known (drag & drop), else 0. */
  files: number
}
const [importState, setImportState] = createSignal<ImportState>({ jobs: 0, files: 0 })
export { importState }

/** Select media (and drop any clip selection so the inspector doesn't show stale clips). */
export function selectMedia(app: CascadeAPI, ids: Id[]) {
  if (app.selection.clips.get().length) app.selection.clips.set([])
  app.selection.media.set(ids)
}

/**
 * Run an import job, exposing progress to the UI, then select what it added.
 * `files` is the number of files being imported when known.
 */
export async function trackImport(app: CascadeAPI, job: () => unknown, files = 0) {
  const before = new Set(app.project().mediaOrder)
  setImportState((s) => ({ jobs: s.jobs + 1, files: s.files + files }))
  try {
    await job()
  } finally {
    setImportState((s) => ({ jobs: Math.max(0, s.jobs - 1), files: Math.max(0, s.files - files) }))
  }
  const added = app.project().mediaOrder.filter((id) => !before.has(id))
  if (added.length) selectMedia(app, added)
}
