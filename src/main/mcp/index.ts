import { app, ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { loadToken } from './auth'
import { startHttp } from './server'

export const mcpInfo: { url: string; enabled: boolean; token: string; command: string; stdio?: { command: string; args: string[]; env?: Record<string, string> } } = { url: '', enabled: false, token: '', command: '' }

/** How a client launches the stdio proxy against this same executable and profile. */
function stdioLaunch() {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--mcp-stdio']
  const env = process.env.CASCADE_USER_DATA ? { CASCADE_USER_DATA: app.getPath('userData') } : undefined
  return { command: process.execPath, args, ...(env ? { env } : {}) }
}
export async function startMcp(window: () => BrowserWindow | null): Promise<void> {
  const root = app.getPath('userData')
  const token = await loadToken(root)
  const enabled = async () => {
    try { mcpInfo.enabled = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))['mcp.enabled'] !== false } catch { mcpInfo.enabled = true }
    return mcpInfo.enabled
  }
  const pending = new Map<string, { sender: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  ipcMain.handle('mcp:reply', (event, id: string, reply: { result?: unknown; error?: string }) => {
    const call = pending.get(id)
    if (!call || event.sender.id !== call.sender) return
    pending.delete(id); clearTimeout(call.timer)
    if (reply.error) call.reject(new Error(reply.error)); else call.resolve(reply.result)
  })
  const { server, url } = await startHttp(token, enabled, (tool, args) => new Promise((resolve, reject) => {
    const target = window()
    if (!target || target.isDestroyed() || target.webContents.isLoadingMainFrame()) { reject(new Error('Editor is not ready. Open Cascade and retry.')); return }
    if (pending.size >= 32) { reject(new Error('Too many outstanding agent calls. Wait for existing calls.')); return }
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Editor call timed out; inspect timeline/history before retrying an edit.')) }, 180000)
    pending.set(id, { sender: target.webContents.id, resolve, reject, timer })
    target.webContents.send('mcp:call', { id, tool, args })
  }))
  await enabled()
  Object.assign(mcpInfo, { url, token, stdio: stdioLaunch(), command: `claude mcp add --transport http cascade ${url} --header "Authorization: Bearer ${token}"` })
  await writeFile(join(root, 'mcp-endpoint.json'), JSON.stringify({ url, token }), { mode: 0o600 })
  await chmod(join(root, 'mcp-endpoint.json'), 0o600)
  console.log(`[mcp] ${mcpInfo.enabled ? 'Enabled' : 'Disabled (enable mcp.enabled in Settings)'}: ${mcpInfo.command}`)
  app.once('before-quit', () => {
    server.closeAllConnections(); server.close()
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Cascade is shutting down')) }
    pending.clear()
  })
}
