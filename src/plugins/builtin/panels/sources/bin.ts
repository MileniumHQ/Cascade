import type { CascadeAPI } from '@core/app'
import { uid, type Id } from '@shared/project'
import {
  BIN_KEY, createFolder, deleteFolder, folderById, moveFolder, moveMedia, readBin, renameFolder, uniqueName, writeBin, type Bin
} from './folders'
import { currentFolder, selectedFolder, setCurrentFolder, setRenamingFolder, setSelectedFolder } from './state'

/** The bin's folder structure as stored in the open project. */
export const binOf = (app: CascadeAPI): Bin => readBin(app.project().pluginData[BIN_KEY])

/** One undoable step that replaces the folder structure. */
function commit(app: CascadeAPI, label: string, change: (bin: Bin) => Bin) {
  const prev = app.project().pluginData[BIN_KEY]
  const next = change(readBin(prev))
  app.doc.transact(label, (d) => {
    d.pluginData[BIN_KEY] = writeBin(prev, next) as never
  })
}

/** The folder shown now, or the root when it no longer exists (deleted, undo, another project). */
export const shownFolder = (app: CascadeAPI): Id | null => (folderById(binOf(app), currentFolder()) ? currentFolder() : null)

/** New folder in the current one (or `parent`), optionally holding `mediaIds`; starts inline rename. */
export function newFolder(app: CascadeAPI, mediaIds: Id[] = [], parent: Id | null = shownFolder(app)): Id {
  const id = uid('fd_')
  commit(app, mediaIds.length ? 'New folder with media' : 'New folder', (bin) => {
    const made = createFolder(bin, id, uniqueName(bin, parent), parent)
    return mediaIds.length ? moveMedia(made, mediaIds, id) : made
  })
  setSelectedFolder(id)
  setRenamingFolder(id)
  return id
}

export const renameBinFolder = (app: CascadeAPI, id: Id, name: string) => commit(app, 'Rename folder', (bin) => renameFolder(bin, id, name))

export function deleteBinFolder(app: CascadeAPI, id: Id) {
  const bin = binOf(app)
  const parent = folderById(bin, id)?.parent ?? null
  commit(app, 'Delete folder', (b) => deleteFolder(b, id))
  if (currentFolder() === id) setCurrentFolder(parent)
  if (selectedFolder() === id) setSelectedFolder(null)
}

export const moveMediaToFolder = (app: CascadeAPI, ids: Id[], folder: Id | null) => commit(app, 'Move to folder', (bin) => moveMedia(bin, ids, folder))

export const moveBinFolder = (app: CascadeAPI, id: Id, parent: Id | null) => commit(app, 'Move folder', (bin) => moveFolder(bin, id, parent))
