import { app, BrowserWindow, ipcMain, Menu, protocol, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HostBridge } from '../shared/ipc'
import { registerExportIpc } from './export'
import { registerTranscribeIpc } from './transcribe'
import { registerAnalysisIpc } from './analysis'
import { stopMediaProcesses } from './ffmpeg'
import { createMediaService } from './media'
import { UserPlugins } from './plugins'
import { serveMedia, servePlugin } from './protocols'
import { getHostPaths, registerStoreIpc } from './store'
import { mcpInfo, startMcp } from './mcp'
import { registerAgentsIpc } from './agents'
import { startUpdater } from './updater'
import { runStdio } from './mcp/stdio'
import { registerLinuxDesktop } from './desktop-integration'

protocol.registerSchemesAsPrivileged(['media', 'cascade-plugin'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true }
})))

// Test/dev isolation: point Cascade at a throwaway profile.
if (process.env.CASCADE_USER_DATA) app.setPath('userData', process.env.CASCADE_USER_DATA)

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let plugins: UserPlugins | undefined
let finishSplash: (() => void) | undefined
let closeSplashTimers: (() => void) | undefined
let splashProgress: { message: string; done: number; total: number } | undefined
const preload = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))

function loadPage(window: BrowserWindow, page: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const loaded = devUrl
    ? window.loadURL(`${devUrl.replace(/\/$/, '')}/${page}.html`)
    : window.loadFile(fileURLToPath(new URL(`../renderer/${page}.html`, import.meta.url)))
  void loaded.catch((error: unknown) => console.error(`Unable to load ${page}:`, error))
}

function createWindows(): void {
  const webPreferences: Electron.WebPreferences = {
    preload, contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true
  }
  const splash = new BrowserWindow({
    width: 400, height: 200, frame: false, resizable: false, backgroundColor: '#0b0b0c',
    transparent: false, center: true, show: false, webPreferences
  })
  const main = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'Cascade',
    // Custom title bar (menus, project) with the platform's own window buttons drawn over it.
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#09090a', symbolColor: '#a8a8b0', height: 37 },
    backgroundColor: '#09090a', show: false, webPreferences
  })
  mainWindow = main
  splashWindow = splash
  splashProgress = undefined
  let shownAt: number | undefined
  let requested = false
  let finished = false
  let minimumTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = (): void => { clearTimeout(minimumTimer); clearTimeout(fallbackTimer) }
  const reveal = (force = false): void => {
    if (finished || main.isDestroyed()) return
    requested = true
    if (!force) {
      if (shownAt === undefined) return
      const remaining = 1200 - (Date.now() - shownAt)
      if (remaining > 0) {
        clearTimeout(minimumTimer)
        minimumTimer = setTimeout(() => reveal(), remaining)
        return
      }
    }
    finished = true
    clearTimers()
    if (!splash.isDestroyed()) splash.destroy()
    main.show()
    main.focus()
  }
  const fallbackTimer = setTimeout(() => reveal(true), 20_000)
  closeSplashTimers = clearTimers
  finishSplash = () => reveal()
  splash.once('ready-to-show', () => {
    if (finished || splash.isDestroyed()) return
    shownAt = Date.now()
    splash.show()
    if (requested) reveal()
  })
  splash.on('closed', () => { if (splashWindow === splash) splashWindow = null })
  splash.webContents.once('did-finish-load', () => {
    if (splashProgress && !splash.isDestroyed()) {
      const { message, done, total } = splashProgress
      splash.webContents.send('splash:progress', message, done, total)
    }
  })
  main.on('closed', () => {
    clearTimers()
    if (!splash.isDestroyed()) splash.destroy()
    if (mainWindow === main) { mainWindow = null; openFileReady = false; finishSplash = undefined; closeSplashTimers = undefined }
  })
  main.on('maximize', () => main.webContents.send('window:maximizeChange', true))
  main.on('unmaximize', () => main.webContents.send('window:maximizeChange', false))
  main.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || input.control && input.shift && input.key.toLowerCase() === 'i')) {
      event.preventDefault()
      main.webContents.toggleDevTools()
    }
  })
  for (const window of [main, splash]) {
    // Links with target=_blank (agent replies, login links) open in the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url).catch(console.warn)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      // Keep the Node-capable preload on the application's own page.
      if (url !== window.webContents.getURL()) event.preventDefault()
    })
  }
  loadPage(splash, 'splash')
  loadPage(main, 'index')
}

function registerWindowIpc(): void {
  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.on('window:setTitle', (event, title: string) => {
    if (typeof title === 'string') BrowserWindow.fromWebContents(event.sender)?.setTitle(title)
  })
  ipcMain.on('window:openFileReady', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    openFileReady = true
    for (const file of pendingOpenFiles.splice(0)) event.sender.send('window:openFile', file)
  })
  ipcMain.on('splash:progress', (event, message: string, done: number, total: number) => {
    if (event.sender !== mainWindow?.webContents) return
    splashProgress = { message, done, total }
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('splash:progress', message, done, total)
  })
  ipcMain.on('splash:ready', (event) => {
    if (event.sender === mainWindow?.webContents) finishSplash?.()
  })
}

async function initialize(): Promise<void> {
  Menu.setApplicationMenu(null)
  // Flatpak exports its own desktop entry and mime type.
  if (process.platform === 'linux' && app.isPackaged && !process.env.FLATPAK_ID) void registerLinuxDesktop(process.resourcesPath).catch((error: unknown) => console.warn('Desktop integration:', error))
  registerWindowIpc()
  registerStoreIpc()
  registerExportIpc()
  const paths = getHostPaths()
  const transcription = await registerTranscribeIpc(paths.userData)
  await registerAnalysisIpc(paths.userData, transcription)
  const media = createMediaService(join(paths.userData, 'cache'))
  // Spell out the wrappers so the public bridge and service signatures stay checked together.
  ipcMain.handle('host:fonts', () => systemFonts())
  ipcMain.handle('media:probe', (_event, path: string) => media.probe(path))
  ipcMain.handle('media:thumbnails', (_event, path: string, opts: Parameters<HostBridge['media']['thumbnails']>[1]) => media.thumbnails(path, opts))
  ipcMain.handle('media:waveform', (_event, path: string) => media.waveform(path))
  ipcMain.handle('media:pcm', (_event, path: string, startSec: number, durationSec: number, sampleRate?: number) => media.pcm(path, startSec, durationSec, sampleRate))
  ipcMain.handle('media:poster', (_event, path: string, atSeconds?: number) => media.poster(path, atSeconds))
  ipcMain.handle('media:proxy', (_event, path: string) => media.proxy(path))
  plugins = new UserPlugins(paths.plugins, (files) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plugins:changed', files)
  })
  const userPlugins = plugins
  const pluginsReady = userPlugins.start().catch((error: unknown) => console.error('Unable to initialize user plugins:', error))
  ipcMain.handle('plugins:list', async () => { await pluginsReady; return userPlugins.list() })
  ipcMain.handle('plugins:write', async (_event, name: string, code: string) => { await pluginsReady; return userPlugins.write(name, code) })
  ipcMain.handle('plugins:remove', async (_event, name: string) => { await pluginsReady; return userPlugins.remove(name) })
  ipcMain.on('plugins:openFolder', () => { void shell.openPath(paths.plugins).then((error) => { if (error) console.warn(error) }).catch(console.warn) })
  protocol.handle('media', serveMedia)
  protocol.handle('cascade-plugin', (request) => servePlugin(request, (name) => userPlugins.code(name)))
  await registerAgentsIpc({ home: paths.home, defaultCwd: paths.projects, dataDir: join(paths.userData, 'agents'), mcp: () => mcpInfo }, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agents:event', event)
  })
  await startUpdater(() => mainWindow)
  createWindows()
  await startMcp(() => mainWindow)
}

// .cascade files the OS hands us (file association): queued until the editor subscribes.
const pendingOpenFiles: string[] = []
let openFileReady = false
function openFiles(argv: string[], cwd = process.cwd()): void {
  for (const arg of argv) {
    if (!/\.cascade$/i.test(arg) || arg.startsWith('-')) continue
    // Linux launchers pass %U as file:// URIs.
    const file = arg.startsWith('file://') ? fileURLToPath(arg) : resolve(cwd, arg)
    if (!existsSync(file)) continue
    if (openFileReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:openFile', file)
    else pendingOpenFiles.push(file)
  }
}

if (process.argv.includes('--mcp-stdio')) {
  void runStdio(app.getPath('userData')).catch(error => { console.error('[mcp proxy]', error); process.exit(1) })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  openFiles(process.argv.slice(1))
  app.on('open-file', (event, file) => { event.preventDefault(); openFiles([file]) })
  app.on('second-instance', (_event, argv, cwd) => {
    openFiles(argv.slice(1), cwd)
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus() }
    else finishSplash?.()
  })
  void app.whenReady().then(initialize).catch((error: unknown) => {
    console.error('Cascade could not start:', error)
    app.quit()
  })
  app.on('activate', () => { if (app.isReady() && !mainWindow) createWindows() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => {
    closeSplashTimers?.()
    plugins?.dispose()
    stopMediaProcesses()
  })
}

let fontList: Promise<string[]> | null = null
/** Installed font families via fontconfig (Linux) or GDI+ (Windows). Cached for the session. */
function systemFonts(): Promise<string[]> {
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }']]
    : ['fc-list', ['--format', '%{family[0]}\\n']]
  fontList ??= new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([])
      const names = new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('.')))
      resolve([...names].sort((a, b) => a.localeCompare(b)))
    })
  })
  return fontList
}
