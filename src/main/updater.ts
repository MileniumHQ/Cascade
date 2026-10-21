// In-app updates from GitHub releases (electron-updater): the Windows installer and the AppImage in place.
// Downloads in the background; the title bar offers "Restart to update" once it's ready. Flatpak copies
// update through Flathub (the software center / `flatpak update`), so they only report that.
import { app, ipcMain, type BrowserWindow } from 'electron'
import type { UpdateState } from '../shared/ipc'

/** How this copy was installed, if it can update itself. */
export function updateKind(platform = process.platform, env = process.env): 'nsis' | 'appimage' | 'flatpak' | null {
  if (platform === 'win32') return 'nsis'
  if (platform !== 'linux') return null
  if (env.FLATPAK_ID) return 'flatpak'
  return env.APPIMAGE ? 'appimage' : null
}

const HOURS = 60 * 60 * 1000

export async function startUpdater(window: () => BrowserWindow | null) {
  let state: UpdateState = { status: 'unsupported', current: app.getVersion() }
  const set = (next: Partial<UpdateState>) => {
    state = { ...state, ...next }
    const w = window()
    if (w && !w.isDestroyed()) w.webContents.send('update:state', state)
  }
  ipcMain.handle('update:state', () => state)
  const kind = app.isPackaged ? updateKind() : null
  if (kind === 'flatpak') state = { ...state, managedBy: 'flatpak' }
  if (!kind || kind === 'flatpak') {
    ipcMain.handle('update:check', () => state)
    ipcMain.handle('update:install', () => {})
    return
  }

  const { autoUpdater } = (await import('electron-updater')).default
  // Testing: point at a local folder of builds (`python -m http.server`) instead of GitHub releases.
  if (process.env.CASCADE_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CASCADE_UPDATE_URL })
  autoUpdater.autoDownload = true
  autoUpdater.logger = { info: () => {}, warn: console.warn, error: () => {}, debug: () => {} } as never
  autoUpdater.on('checking-for-update', () => { if (state.status !== 'ready' && state.status !== 'downloading') set({ status: 'checking', error: undefined }) })
  autoUpdater.on('update-not-available', () => set({ status: 'idle', checkedAt: Date.now() }))
  autoUpdater.on('update-available', info => set({ status: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', p => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', info => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', error => set({ status: 'error', error: String(error?.message ?? error).split('\n')[0].slice(0, 300) }))
  state = { status: 'idle', current: app.getVersion() }

  const check = async () => {
    if (state.status === 'ready' || state.status === 'downloading') return state
    try { await autoUpdater.checkForUpdates() } catch { /* Reported through 'error'. */ }
    return state
  }
  ipcMain.handle('update:check', check)
  // isSilent: the installer runs without its wizard; forceRunAfter: Cascade reopens afterwards.
  ipcMain.handle('update:install', () => { if (state.status === 'ready') setImmediate(() => autoUpdater.quitAndInstall(true, true)) })
  setTimeout(() => void check(), 15_000).unref()
  setInterval(() => void check(), 4 * HOURS).unref()
}
