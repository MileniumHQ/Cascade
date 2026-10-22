import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HostBridge, McpCall, RenderWorkerBridge } from '../shared/ipc'

function on<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: HostBridge = {
  info: () => ipcRenderer.invoke('host:info'),
  fonts: () => ipcRenderer.invoke('host:fonts'),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    setTitle: (title) => ipcRenderer.send('window:setTitle', title),
    onMaximizeChange: (fn) => on('window:maximizeChange', fn),
    onOpenFile: (fn) => {
      const off = on('window:openFile', fn)
      ipcRenderer.send('window:openFileReady')
      return off
    }
  },
  dialog: {
    openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts),
    saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
    confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts)
  },
  fs: {
    readText: (path) => ipcRenderer.invoke('fs:readText', path),
    writeText: (path, text) => ipcRenderer.invoke('fs:writeText', path, text),
    exists: (path) => ipcRenderer.invoke('fs:exists', path),
    stat: (path) => ipcRenderer.invoke('fs:stat', path),
    existsMany: (paths) => ipcRenderer.invoke('fs:existsMany', paths),
    findByName: (dir, names) => ipcRenderer.invoke('fs:findByName', dir, names),
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  projects: {
    recent: () => ipcRenderer.invoke('projects:recent'),
    addRecent: (p) => ipcRenderer.invoke('projects:addRecent', p),
    removeRecent: (path) => ipcRenderer.invoke('projects:removeRecent', path)
  },
  recovery: {
    list: () => ipcRenderer.invoke('recovery:list'),
    write: (meta, text) => ipcRenderer.invoke('recovery:write', meta, text),
    read: (id) => ipcRenderer.invoke('recovery:read', id),
    discard: (id) => ipcRenderer.invoke('recovery:discard', id)
  },
  media: {
    probe: (path) => ipcRenderer.invoke('media:probe', path),
    thumbnails: (path, opts) => ipcRenderer.invoke('media:thumbnails', path, opts),
    waveform: (path) => ipcRenderer.invoke('media:waveform', path),
    pcm: (path, startSec, durationSec, sampleRate) => ipcRenderer.invoke('media:pcm', path, startSec, durationSec, sampleRate),
    proxy: (path) => ipcRenderer.invoke('media:proxy', path),
    poster: (path, atSeconds) => ipcRenderer.invoke('media:poster', path, atSeconds)
  },
  transcribe: {
    status: () => ipcRenderer.invoke('transcribe:status'),
    installModel: (id) => ipcRenderer.invoke('transcribe:installModel', id),
    run: (path, opts) => ipcRenderer.invoke('transcribe:run', path, opts),
    cancel: () => ipcRenderer.invoke('transcribe:cancel'),
    onProgress: (fn) => on('transcribe:progress', fn)
  },
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (fn) => on('update:state', fn)
  },
  agents: {
    providers: () => ipcRenderer.invoke('agents:providers'),
    start: (providerId, options) => ipcRenderer.invoke('agents:start', providerId, options),
    prompt: (id, text, attachments) => ipcRenderer.invoke('agents:prompt', id, text, attachments),
    cancel: (id) => ipcRenderer.invoke('agents:cancel', id),
    setOption: (id, configId, value) => ipcRenderer.invoke('agents:setOption', id, configId, value),
    respond: (id, requestId, optionId) => ipcRenderer.invoke('agents:respond', id, requestId, optionId),
    close: (id) => ipcRenderer.invoke('agents:close', id),
    install: (providerId) => ipcRenderer.invoke('agents:install', providerId),
    usage: (providerId, fresh) => ipcRenderer.invoke('agents:usage', providerId, fresh),
    keyProviders: (providerId) => ipcRenderer.invoke('agents:keyProviders', providerId),
    saveKey: (providerId, target, key) => ipcRenderer.invoke('agents:saveKey', providerId, target, key),
    removeKey: (providerId, target) => ipcRenderer.invoke('agents:removeKey', providerId, target),
    onEvent: (fn) => on('agents:event', fn)
  },
  analysis: {
    status: () => ipcRenderer.invoke('analysis:status'),
    installModels: (parts) => ipcRenderer.invoke('analysis:installModels', parts),
    run: (path, opts) => ipcRenderer.invoke('analysis:run', path, opts),
    cached: (path) => ipcRenderer.invoke('analysis:cached', path),
    cancel: () => ipcRenderer.invoke('analysis:cancel'),
    onProgress: (fn) => on('analysis:progress', fn)
  },
  export: {
    start: (req) => ipcRenderer.invoke('export:start', req),
    cancel: (jobId) => ipcRenderer.invoke('export:cancel', jobId),
    frame: (req) => ipcRenderer.invoke('export:frame', req),
    onProgress: (fn) => on('export:progress', fn)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    write: (name, code) => ipcRenderer.invoke('plugins:write', name, code),
    remove: (name) => ipcRenderer.invoke('plugins:remove', name),
    openFolder: () => ipcRenderer.send('plugins:openFolder'),
    onChange: (fn) => on('plugins:changed', fn)
  },
  mcp: {
    onCall: (fn) => on<McpCall>('mcp:call', (call) => {
      void (async () => {
        try {
          const result = await fn(call)
          await ipcRenderer.invoke('mcp:reply', call.id, { result })
        } catch (error) {
          await ipcRenderer.invoke('mcp:reply', call.id, { error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => console.warn('Unable to send MCP reply:', error))
    })
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (values) => ipcRenderer.invoke('settings:save', values)
  },
  splash: {
    progress: (message, done, total) => ipcRenderer.send('splash:progress', message, done, total),
    ready: () => ipcRenderer.send('splash:ready'),
    onProgress: (fn) => {
      const listener = (_event: IpcRendererEvent, message: string, done: number, total: number): void => fn({ message, done, total })
      ipcRenderer.on('splash:progress', listener)
      return () => ipcRenderer.removeListener('splash:progress', listener)
    }
  },
  shell: {
    showItemInFolder: (path) => ipcRenderer.send('shell:showItemInFolder', path),
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url)
  }
}

if (new URL(globalThis.location.href).pathname.endsWith('/render.html')) {
  const render: RenderWorkerBridge = {
    job: () => ipcRenderer.invoke('render:job'),
    frameReady: (index) => ipcRenderer.send('render:frameReady', index),
    audioChunk: (index, pcm) => ipcRenderer.send('render:audioChunk', index, pcm),
    done: () => ipcRenderer.send('render:done'),
    error: (message) => ipcRenderer.send('render:error', message),
    onCommand: (fn) => on('render:command', fn)
  }
  bridge.render = render
}

contextBridge.exposeInMainWorld('cascade', bridge)
