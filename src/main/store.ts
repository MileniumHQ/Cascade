import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HostBridge, HostInfo, RecentProject } from '../shared/ipc'
import { getFFmpegInfo } from './ffmpeg'
import { mcpInfo } from './mcp'

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

/** Serialize updates so overlapping invokes don't lose recent entries or settings. */
export class JsonStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(readonly root: string) {}

  async loadSettings(): Promise<Record<string, unknown>> {
    await this.pending
    const value = await readJson<unknown>(join(this.root, 'settings.json'), {})
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }

  async recent(): Promise<RecentProject[]> {
    await this.pending
    return this.readRecent()
  }

  private async readRecent(): Promise<RecentProject[]> {
    const values = await readJson<unknown>(join(this.root, 'recent.json'), [])
    return Array.isArray(values) ? values.filter((p): p is RecentProject => p && typeof p.path === 'string' && typeof p.name === 'string' && typeof p.openedAt === 'number').sort((a, b) => b.openedAt - a.openedAt).slice(0, 20) : []
  }

  private update(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work)
    this.pending = next.catch(() => {})
    return next
  }

  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const output = join(this.root, name)
    await writeFile(`${output}.tmp`, JSON.stringify(value, null, 2), 'utf8')
    await rename(`${output}.tmp`, output)
  }

  saveSettings(values: Record<string, unknown>): Promise<void> {
    return this.update(() => this.write('settings.json', values))
  }

  addRecent(project: RecentProject): Promise<void> {
    return this.update(async () => {
      const recent = (await this.readRecent()).filter((p) => p.path !== project.path)
      recent.push(project)
      await this.write('recent.json', recent.sort((a, b) => b.openedAt - a.openedAt).slice(0, 20))
    })
  }

  removeRecent(path: string): Promise<void> {
    return this.update(async () => this.write('recent.json', (await this.readRecent()).filter((p) => p.path !== path)))
  }
}

export function getHostPaths(): HostInfo['paths'] {
  return {
    userData: app.getPath('userData'), documents: app.getPath('documents'), home: app.getPath('home'),
    plugins: join(app.getPath('userData'), 'plugins'), projects: process.env.CASCADE_PROJECTS ?? join(app.getPath('documents'), 'Cascade Projects')
  }
}

export function registerStoreIpc(): void {
  const paths = getHostPaths()
  const store = new JsonStore(paths.userData)
  ipcMain.handle('host:info', async (): Promise<HostInfo> => {
    await mkdir(paths.projects, { recursive: true })
    return {
      platform: process.platform,
      versions: Object.fromEntries(Object.entries(process.versions).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      paths, ffmpeg: await getFFmpegInfo(), mcp: { ...mcpInfo, enabled: (await store.loadSettings())['mcp.enabled'] !== false }
    }
  })
  ipcMain.handle('settings:load', () => store.loadSettings())
  ipcMain.handle('settings:save', (_event, values: Record<string, unknown>) => store.saveSettings(values))
  ipcMain.handle('projects:recent', () => store.recent())
  ipcMain.handle('projects:addRecent', (_event, project: RecentProject) => store.addRecent(project))
  ipcMain.handle('projects:removeRecent', (_event, path: string) => store.removeRecent(path))
  ipcMain.handle('fs:readText', (_event, path: string) => readFile(path, 'utf8'))
  ipcMain.handle('fs:writeText', async (_event, path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  })
  ipcMain.handle('fs:exists', async (_event, path: string) => {
    try { await access(path); return true } catch { return false }
  })
  ipcMain.handle('fs:stat', async (_event, path: string) => {
    try { const value = await stat(path); return { size: value.size, mtime: value.mtimeMs } } catch { return null }
  })
  ipcMain.handle('dialog:openFiles', async (event, opts: Parameters<HostBridge['dialog']['openFiles']>[0] = {}) => {
    const options: Electron.OpenDialogOptions = {
      title: opts.title, filters: opts.filters,
      properties: [opts.directory ? 'openDirectory' : 'openFile', ...(opts.multi ? ['multiSelections' as const] : [])]
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('dialog:saveFile', async (event, opts: Parameters<HostBridge['dialog']['saveFile']>[0]) => {
    await mkdir(paths.projects, { recursive: true })
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { ...opts, defaultPath: opts.defaultPath ?? paths.projects }
    const result = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
    return result.canceled ? null : result.filePath ?? null
  })
  ipcMain.handle('dialog:confirm', async (event, opts: Parameters<HostBridge['dialog']['confirm']>[0]) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.MessageBoxOptions = { ...opts, type: 'question', noLink: true }
    return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response
  })
  ipcMain.on('shell:showItemInFolder', (_event, path: string) => { if (typeof path === 'string') shell.showItemInFolder(path) })
  ipcMain.on('shell:openExternal', (_event, url: string) => {
    // OS URL handlers must never be able to execute javascript or local applications.
    try {
      if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch(console.warn)
    } catch { /* Invalid URLs are ignored. */ }
  })
}
