import type { Id } from '@shared/project'
import { compareNames } from './format'

/** Where the bin's folder structure lives in the project document (`project.pluginData`). */
export const BIN_KEY = 'cascade.sources'

export interface Folder {
  id: Id
  name: string
  /** Parent folder, null at the root. */
  parent: Id | null
}

export interface Bin {
  folders: Folder[]
  /** Media id → folder id. Media without an entry (or pointing at a missing folder) lives at the root. */
  placement: Record<Id, Id>
}

export const emptyBin = (): Bin => ({ folders: [], placement: {} })

/** Make any stored value usable: bad entries drop out, orphans and cycles fall back to the root. */
export function readBin(raw: unknown): Bin {
  const src = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof Bin, unknown>>) : {}
  const seen = new Set<Id>()
  const folders: Folder[] = []
  if (Array.isArray(src.folders)) {
    for (const f of src.folders as Partial<Folder>[]) {
      if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || seen.has(f.id)) continue
      seen.add(f.id)
      folders.push({ id: f.id, name: f.name, parent: typeof f.parent === 'string' ? f.parent : null })
    }
  }
  for (const f of folders) if (f.parent !== null && !seen.has(f.parent)) f.parent = null
  // Break cycles by lifting the folder that closes one to the root.
  for (const f of folders) {
    const chain = new Set<Id>([f.id])
    for (let p = f.parent; p !== null; ) {
      if (chain.has(p)) {
        f.parent = null
        break
      }
      chain.add(p)
      p = folders.find((x) => x.id === p)?.parent ?? null
    }
  }
  const placement: Record<Id, Id> = {}
  if (src.placement && typeof src.placement === 'object') {
    for (const [mid, fid] of Object.entries(src.placement as Record<string, unknown>)) if (typeof fid === 'string' && seen.has(fid)) placement[mid] = fid
  }
  return { folders, placement }
}

/** The value to store: new structure over whatever else the stored object carried. */
export const writeBin = (raw: unknown, bin: Bin): unknown => ({ ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), ...bin })

export const folderById = (bin: Bin, id: Id | null): Folder | undefined => (id === null ? undefined : bin.folders.find((f) => f.id === id))

/** Folder a media item is in, null for the root. */
export const folderOf = (bin: Bin, mediaId: Id): Id | null => bin.placement[mediaId] ?? null

export function childFolders(bin: Bin, parent: Id | null): Folder[] {
  return bin.folders.filter((f) => f.parent === parent).sort((a, b) => compareNames(a.name, b.name))
}

/** Root → folder, for the breadcrumb. */
export function pathTo(bin: Bin, id: Id | null): Folder[] {
  const out: Folder[] = []
  for (let f = folderById(bin, id); f && !out.includes(f); f = folderById(bin, f.parent)) out.unshift(f)
  return out
}

/** The folder and everything below it. */
export function subtree(bin: Bin, id: Id): Set<Id> {
  const out = new Set<Id>([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of bin.folders) if (f.parent !== null && out.has(f.parent) && !out.has(f.id)) (out.add(f.id), (grew = true))
  }
  return out
}

/** Media in a folder, including nested folders when `deep`. */
export function mediaIn(bin: Bin, folder: Id | null, mediaIds: Id[], deep = false): Id[] {
  if (deep && folder !== null) {
    const tree = subtree(bin, folder)
    return mediaIds.filter((m) => tree.has(bin.placement[m]))
  }
  return mediaIds.filter((m) => folderOf(bin, m) === folder)
}

/** "New folder", "New folder 2"… unique among the siblings. */
export function uniqueName(bin: Bin, parent: Id | null, base = 'New folder', ignore?: Id): string {
  const taken = new Set(bin.folders.filter((f) => f.parent === parent && f.id !== ignore).map((f) => f.name.toLowerCase()))
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`
  return name
}

export function createFolder(bin: Bin, id: Id, name: string, parent: Id | null): Bin {
  const at = folderById(bin, parent) ? parent : null
  return { ...bin, folders: [...bin.folders, { id, name: name.trim() || uniqueName(bin, at), parent: at }] }
}

export function renameFolder(bin: Bin, id: Id, name: string): Bin {
  const trimmed = name.trim()
  if (!trimmed) return bin
  return { ...bin, folders: bin.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) }
}

/** Remove a folder; its media and subfolders move to its parent. */
export function deleteFolder(bin: Bin, id: Id): Bin {
  const gone = folderById(bin, id)
  if (!gone) return bin
  const placement: Record<Id, Id> = {}
  for (const [m, f] of Object.entries(bin.placement)) {
    if (f !== id) placement[m] = f
    else if (gone.parent !== null) placement[m] = gone.parent
  }
  return {
    folders: bin.folders.filter((f) => f.id !== id).map((f) => (f.parent === id ? { ...f, parent: gone.parent } : f)),
    placement
  }
}

/** Put media in a folder (null = root). */
export function moveMedia(bin: Bin, mediaIds: Id[], folder: Id | null): Bin {
  const to = folderById(bin, folder) ? folder : null
  const placement = { ...bin.placement }
  for (const m of mediaIds) {
    if (to === null) delete placement[m]
    else placement[m] = to
  }
  return { ...bin, placement }
}

/** Nest a folder under another (null = root). Ignored when it would put a folder inside itself. */
export function moveFolder(bin: Bin, id: Id, parent: Id | null): Bin {
  if (!folderById(bin, id) || (parent !== null && (!folderById(bin, parent) || subtree(bin, id).has(parent)))) return bin
  return { ...bin, folders: bin.folders.map((f) => (f.id === id ? { ...f, parent } : f)) }
}
