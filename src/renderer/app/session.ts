import { createSignal } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { createProject, PROJECT_VERSION, type Project, type ProjectSettings } from '@shared/project'

/** Which screen is showing and where the open project lives on disk. */
export function createSession(app: CascadeApp) {
  const host = app.host!
  const [screen, setScreen] = createSignal<'home' | 'editor'>('home')
  const [path, setPath] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  let autosaveTimer = 0

  app.doc.onChange.on((e) => {
    if (e.source === 'load') return
    clearTimeout(autosaveTimer)
    if (path()) autosaveTimer = window.setTimeout(() => void save(), 4000)
  })

  async function defaultPath(name: string) {
    const info = await host.info()
    const safe = name.replace(/[^\w\- ]+/g, '').trim() || 'Untitled'
    return `${info.paths.projects}/${safe}.cascade`
  }

  async function newProject(name: string, settings: Partial<ProjectSettings>) {
    const project = createProject(name, settings)
    app.doc.load(project)
    app.playback.seek(0)
    app.selection.setClips([])
    const p = await defaultPath(name)
    let target = p
    for (let i = 2; await host.fs.exists(target); i++) target = p.replace(/\.cascade$/, ` ${i}.cascade`)
    setPath(target)
    await save()
    setScreen('editor')
  }

  async function open(file: string) {
    try {
      const text = await host.fs.readText(file)
      const project = JSON.parse(text) as Project
      if (!project.version || project.version > PROJECT_VERSION) throw new Error(`Unsupported project version ${project.version}`)
      app.doc.load(project)
      app.playback.seek(0)
      app.selection.setClips([])
      setPath(file)
      app.doc.markSaved()
      await host.projects.addRecent({ path: file, name: project.name, openedAt: Date.now() })
      setScreen('editor')
      host.window.setTitle(`${project.name} — Cascade`)
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
      const project = { ...app.project(), modifiedAt: Date.now() }
      await host.fs.writeText(file, JSON.stringify(project))
      app.doc.markSaved()
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
    setScreen('home')
    setPath(null)
    host.window.setTitle('Cascade')
  }

  return { screen, path, saving, newProject, open, openDialog, save, saveAs, close }
}

export type Session = ReturnType<typeof createSession>
