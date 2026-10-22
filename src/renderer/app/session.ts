import { createSignal } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { createProject, PROJECT_VERSION, type Project, type ProjectSettings } from '@shared/project'
import { createThrottledTrigger, isRecoverable, pickRecovery, type RecoveryMeta } from '@shared/recovery'

/** Recovery snapshots: written this long after the last edit, and at least this often while editing continues. */
const SNAPSHOT_DELAY = 3000
const SNAPSHOT_MAX_WAIT = 10000

/** A recovery snapshot that is newer than its project file (or has none). */
export interface Recoverable {
  meta: RecoveryMeta
  /** The project file no longer exists. */
  fileMissing: boolean
}

const clock = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

/** Which screen is showing and where the open project lives on disk. */
export function createSession(app: CascadeApp) {
  const host = app.host!
  const [screen, setScreen] = createSignal<'home' | 'editor'>('home')
  const [path, setPath] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  let autosaveTimer = 0

  /** Every edit also refreshes the crash-recovery snapshot, so even a project that was never saved survives a crash. */
  const snapshot = createThrottledTrigger(() => {
    if (screen() !== 'editor') return
    const project = app.project()
    const meta: RecoveryMeta = { id: project.id, name: project.name, path: path() ?? undefined, savedAt: Date.now() }
    void host.recovery.write(meta, JSON.stringify(project)).catch((e: unknown) => console.warn('Recovery snapshot failed:', e))
  }, SNAPSHOT_DELAY, SNAPSHOT_MAX_WAIT)

  app.doc.onChange.on((e) => {
    if (e.source === 'load') return
    clearTimeout(autosaveTimer)
    if (path()) autosaveTimer = window.setTimeout(() => void save(), 4000)
    snapshot.poke()
  })

  // Files can disappear while the window is in the background.
  window.addEventListener('focus', () => {
    if (screen() === 'editor') void app.media.check()
  })

  const dropSnapshot = (id: string) => host.recovery.discard(id).catch((e: unknown) => console.warn('Recovery cleanup failed:', e))

  async function uniquePath(name: string) {
    const p = await defaultPath(name)
    let target = p
    for (let i = 2; await host.fs.exists(target); i++) target = p.replace(/\.cascade$/, ` ${i}.cascade`)
    return target
  }

  function enter(project: Project, file: string) {
    app.doc.load(project)
    app.playback.seek(0)
    app.selection.setClips([])
    setPath(file)
    setScreen('editor')
    host.window.setTitle(`${project.name} — Cascade`)
  }

  function parse(text: string): Project {
    const project = JSON.parse(text) as Project
    if (!project.version || project.version > PROJECT_VERSION) throw new Error(`Unsupported project version ${project.version}`)
    return project
  }

  /** Snapshots worth offering: newer than their project file. Older ones are cleaned up. */
  async function listRecoverable(): Promise<Recoverable[]> {
    const out: Recoverable[] = []
    for (const meta of await host.recovery.list().catch(() => [] as RecoveryMeta[])) {
      const stat = meta.path ? await host.fs.stat(meta.path) : null
      if (isRecoverable(meta, stat?.mtime ?? null)) out.push({ meta, fileMissing: !stat })
      else void dropSnapshot(meta.id)
    }
    return out
  }

  /** Open a snapshot and save it straight away, so it becomes the project's file. */
  async function recover(meta: RecoveryMeta) {
    try {
      const text = await host.recovery.read(meta.id)
      if (!text) throw new Error('The snapshot is gone')
      const project = parse(text)
      enter(project, meta.path ?? (await uniquePath(project.name)))
      if (await save()) app.notify('success', 'Recovered unsaved changes', `${project.name} from ${clock(meta.savedAt)}`)
    } catch (e) {
      app.notify('error', "Couldn't recover project", String(e))
      await dropSnapshot(meta.id)
    }
  }

  const discardRecovery = dropSnapshot

  async function defaultPath(name: string) {
    const info = await host.info()
    const safe = name.replace(/[^\w\- ]+/g, '').trim() || 'Untitled'
    const sep = /^[a-zA-Z]:\\/.test(info.paths.projects) ? '\\' : '/'
    return `${info.paths.projects}${sep}${safe}.cascade`
  }

  async function newProject(name: string, settings: Partial<ProjectSettings>) {
    const project = createProject(name, settings)
    // The file is written on the first edit (autosave) or an explicit save, so an untouched new project leaves nothing behind.
    enter(project, await uniquePath(name))
  }

  async function open(file: string) {
    try {
      let project = parse(await host.fs.readText(file))
      // A newer snapshot means the last session ended before its changes reached this file.
      const stat = await host.fs.stat(file)
      const found = pickRecovery(await host.recovery.list().catch(() => [] as RecoveryMeta[]), file, stat?.mtime ?? null)
      let recovered = false
      if (found) {
        const choice = await host.dialog.confirm({
          message: `Recover unsaved changes from ${clock(found.savedAt)}?`,
          detail: `“${found.name}” has changes that were never saved to its file.`,
          buttons: ['Recover', 'Discard']
        })
        const text = choice === 0 ? await host.recovery.read(found.id) : null
        if (text) {
          project = parse(text)
          recovered = true
        } else await dropSnapshot(found.id)
      }
      enter(project, file)
      app.doc.markSaved()
      await host.projects.addRecent({ path: file, name: project.name, openedAt: Date.now() })
      if (recovered) await save()
    } catch (e) {
      app.notify('error', "Couldn't open project", String(e))
      await host.projects.removeRecent(file)
    }
  }

  async function openDialog() {
    const files = await host.dialog.openFiles({ title: 'Open project', filters: [{ name: 'Cascade project', extensions: ['cascade'] }] })
    if (files[0]) await open(files[0])
  }

  async function save(): Promise<boolean> {
    let file = path()
    if (!file) {
      file = await host.dialog.saveFile({ title: 'Save project', defaultPath: await defaultPath(app.project().name), filters: [{ name: 'Cascade project', extensions: ['cascade'] }] })
      if (!file) return false
      setPath(file)
    }
    setSaving(true)
    try {
      const revision = app.project()
      const project = { ...revision, modifiedAt: Date.now() }
      await host.fs.writeText(file, JSON.stringify(project))
      app.doc.markSaved()
      // The file now matches, so the snapshot is redundant (unless more edits arrived while writing).
      if (app.project() === revision) {
        snapshot.cancel()
        await dropSnapshot(project.id)
      }
      await host.projects.addRecent({ path: file, name: project.name, openedAt: Date.now() })
      host.window.setTitle(`${project.name} — Cascade`)
      return true
    } catch (e) {
      app.notify('error', 'Save failed', String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function saveAs() {
    const file = await host.dialog.saveFile({ title: 'Save project as', defaultPath: path() ?? (await defaultPath(app.project().name)), filters: [{ name: 'Cascade project', extensions: ['cascade'] }] })
    if (!file) return
    setPath(file)
    await save()
  }

  async function close() {
    if (app.doc.dirty && path()) await save()
    // A snapshot only outlives the project when its changes couldn't be saved.
    snapshot.cancel()
    if (!app.doc.dirty) await dropSnapshot(app.project().id)
    setScreen('home')
    setPath(null)
    host.window.setTitle('Cascade')
  }

  return { screen, path, saving, newProject, open, openDialog, save, saveAs, close, listRecoverable, recover, discardRecovery }
}

export type Session = ReturnType<typeof createSession>
