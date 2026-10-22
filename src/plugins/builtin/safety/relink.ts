import type { CascadeAPI } from '@core/app'
import type { HostBridge } from '@shared/ipc'
import type { Id } from '@shared/project'
import { baseName, dirName, findRelinks, searchFolder, type OfflineFile, type RelinkIO } from '@shared/relink'

const ioFor = (host: HostBridge): RelinkIO => ({
  exists: (paths) => host.fs.existsMany(paths),
  findByName: (dir, names) => host.fs.findByName(dir, names)
})

/** File-backed items whose file is missing. */
export function offlineFiles(app: CascadeAPI): OfflineFile[] {
  const media = app.project().media
  return [...app.media.offline.get()].flatMap((id) => (media[id]?.path ? [{ id, path: media[id].path! }] : []))
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Ask for the file behind one offline item, relink it, then use the same move (old folder → new
 * folder, plus a search of the chosen folder by file name) to relink the other missing files.
 */
export async function relinkWithDialog(app: CascadeAPI, mediaId?: Id): Promise<void> {
  const host = app.host
  if (!host) return
  const offline = offlineFiles(app)
  const target = offline.find((f) => f.id === mediaId) ?? offline.find((f) => app.selection.media.get().includes(f.id)) ?? offline[0]
  if (!target) {
    app.notify('info', 'No media is missing')
    return
  }
  const name = app.project().media[target.id]?.name ?? baseName(target.path)
  const [file] = await host.dialog.openFiles({ title: `Locate ${name}` })
  if (!file) return
  if (!(await app.edit.relinkMedia(target.id, file))) return
  const others = offline.filter((f) => f.id !== target.id)
  if (!others.length) return
  const found = await findRelinks(others, { oldPath: target.path, newPath: file }, dirName(file), ioFor(host))
  const done = found.length ? await app.edit.relinkMediaMany(found.map((f) => ({ mediaId: f.id, path: f.path }))) : []
  if (done.length) app.notify('success', `Relinked ${plural(done.length, 'more file')}`, `${plural(others.length - done.length, 'file')} still missing`)
  else if (others.length) app.notify('info', `${plural(others.length, 'file')} still missing`)
}

/** Pick a folder and relink every missing file found in it by name. */
export async function relinkAllWithDialog(app: CascadeAPI): Promise<void> {
  const host = app.host
  if (!host) return
  const offline = offlineFiles(app)
  if (!offline.length) {
    app.notify('info', 'No media is missing')
    return
  }
  const [dir] = await host.dialog.openFiles({ title: 'Folder to search for missing media', directory: true })
  if (!dir) return
  const found = await searchFolder(offline, dir, ioFor(host))
  const done = found.length ? await app.edit.relinkMediaMany(found.map((f) => ({ mediaId: f.id, path: f.path }))) : []
  if (done.length) app.notify('success', `Relinked ${plural(done.length, 'file')}`, offline.length > done.length ? `${plural(offline.length - done.length, 'file')} still missing` : undefined)
  else app.notify('warning', 'No matching files found', dir)
}
