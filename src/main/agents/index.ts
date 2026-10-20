// Agent panel host: one ACP agent subprocess per chat, with Cascade's MCP server attached.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, constants, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type McpServer, type PromptRequest, type PromptResponse, type RequestPermissionResponse, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk'
import { tools as cascadeTools } from '../mcp/catalog'
import type { AgentEvent, AgentProvider, AgentSession, SessionConfigOption, StopReason } from '../../shared/agents'

/** How to launch an agent. `script` = a bundled Node entry run with Electron-as-Node. */
export interface AgentLauncher { id: string; name: string; icon: AgentProvider['icon']; script?: string; command?: string; args?: string[] }

export const LAUNCHERS: AgentLauncher[] = [
  { id: 'claude', name: 'Claude Code', icon: 'claude', script: '@agentclientprotocol/claude-agent-acp/dist/index.js' },
  { id: 'codex', name: 'Codex', icon: 'codex', script: '@agentclientprotocol/codex-acp/dist/index.js' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', command: 'opencode', args: ['acp'] },
  { id: 'gemini', name: 'Gemini CLI', icon: 'gemini', command: 'gemini', args: ['--experimental-acp'] }
]

/** First prompt preamble: what the agent is embedded in and how to reach the editor. */
export const CONTEXT = `[Context from Cascade] You are running inside the agent panel of Cascade, a video editor. The user is looking at the editor next to this chat. The \`cascade\` MCP server controls the open project live (undoable): inspect with timeline_get/project_get, see with frame_get or contact sheets, edit with timeline_apply_edits, analyze speech with media_analyze then transcript_get. Prefer those tools over editing project files on disk. Keep replies short; the panel is narrow.`

/** Cascade's read-only tools run without asking (Claude Code naming); edits, shell and file writes still ask in manual mode. */
export const READ_ONLY_TOOLS = cascadeTools.filter(t => t.annotations.readOnlyHint).map(t => `mcp__cascade__${t.name}`)

/** GUI launches often miss shell PATH entries (nvm, ~/.local/bin, bun). */
export async function searchPath(home: string, env = process.env.PATH ?? ''): Promise<string[]> {
  const extra = [join(home, '.local/bin'), join(home, '.bun/bin'), join(home, '.npm-global/bin'), '/usr/local/bin', '/usr/bin']
  const nvm = join(home, '.nvm/versions/node')
  try { for (const v of (await readdir(nvm)).sort().reverse()) extra.push(join(nvm, v, 'bin')) } catch { /* No nvm. */ }
  return [...new Set([...env.split(delimiter).filter(Boolean), ...extra])]
}
async function which(command: string, dirs: string[]) {
  for (const dir of dirs) {
    const path = join(dir, command)
    try { await access(path, constants.X_OK); return path } catch { /* Keep looking. */ }
  }
  return undefined
}

interface Chat {
  id: string
  child: ChildProcess
  connection: ClientConnection
  sessionId: string
  primed: boolean
  permissions: Map<string, (response: RequestPermissionResponse) => void>
  stderr: string
}

export interface AgentHostOptions {
  home: string
  defaultCwd: string
  /** Cascade MCP endpoint, read at session start (it may start after the host). */
  mcp: () => { url: string; token: string }
  emit: (event: AgentEvent) => void
  /** Resolve a bundled module path (overridable for tests). */
  resolve?: (specifier: string) => string
  /** Node runtime for bundled scripts: Electron with ELECTRON_RUN_AS_NODE. */
  node?: string
}

export function createAgentHost(options: AgentHostOptions) {
  const require = createRequire(import.meta.url)
  // Packaged: run the unpacked copy so adapters find their native binaries next to them.
  const resolve = options.resolve ?? ((s: string) => require.resolve(s).replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'))
  const chats = new Map<string, Chat>()

  async function launch(l: AgentLauncher): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string }> {
    const dirs = await searchPath(options.home)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirs.join(delimiter) }
    delete env.ELECTRON_RUN_AS_NODE
    if (l.script) {
      try { return { command: options.node ?? process.execPath, args: [resolve(l.script)], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } } catch { return { error: 'Bundled adapter missing; reinstall Cascade.' } }
    }
    const path = await which(l.command!, dirs)
    return path ? { command: path, args: l.args ?? [], env } : { error: `\`${l.command}\` not found on PATH. Install it to use ${l.name}.` }
  }

  async function providers(): Promise<AgentProvider[]> {
    return Promise.all(LAUNCHERS.map(async l => {
      const how = await launch(l)
      return { id: l.id, name: l.name, icon: l.icon, available: !('error' in how), ...('error' in how ? { reason: how.error } : {}) }
    }))
  }

  const get = (id: string) => {
    const chat = chats.get(id)
    if (!chat) throw new Error('This chat has ended. Start a new one.')
    return chat
  }

  async function start(providerId: string, cwd?: string): Promise<AgentSession> {
    const launcher = LAUNCHERS.find(l => l.id === providerId)
    if (!launcher) throw new Error(`Unknown agent ${providerId}`)
    const how = await launch(launcher)
    if ('error' in how) throw new Error(how.error)
    const dir = cwd && isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : options.defaultCwd
    const id = randomUUID()
    const child = spawn(how.command, how.args, { cwd: dir, env: how.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const chat = { id, child, sessionId: '', primed: false, permissions: new Map(), stderr: '' } as unknown as Chat
    child.stderr!.on('data', (b: Buffer) => { chat.stderr = (chat.stderr + b.toString()).slice(-4000) })
    const app = client({ name: 'cascade' })
      .onNotification('session/update', ({ params }) => { if (params.sessionId === chat.sessionId) options.emit({ chatId: id, type: 'update', update: params.update }) })
      .onRequest('session/request_permission', ({ params, signal }) => new Promise<RequestPermissionResponse>(done => {
        const requestId = randomUUID()
        const finish = (response: RequestPermissionResponse) => {
          if (!chat.permissions.delete(requestId)) return
          options.emit({ chatId: id, type: 'permission-resolved', requestId })
          done(response)
        }
        chat.permissions.set(requestId, finish)
        signal.addEventListener('abort', () => finish({ outcome: { outcome: 'cancelled' } }), { once: true })
        options.emit({ chatId: id, type: 'permission', requestId, toolCall: params.toolCall, options: params.options })
      }))
    chat.connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
    chats.set(id, chat)
    const exited = new Promise<never>((_, reject) => {
      child.once('error', error => reject(error))
      child.once('exit', code => reject(new Error(`${launcher.name} exited (${code}). ${lastLines(chat.stderr)}`)))
    })
    exited.catch(error => {
      if (!chats.delete(id)) return
      for (const finish of chat.permissions.values()) finish({ outcome: { outcome: 'cancelled' } })
      chat.connection.close()
      options.emit({ chatId: id, type: 'exit', message: error instanceof Error ? error.message : String(error) })
    })
    try {
      const init = await Promise.race([chat.connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cascade', title: 'Cascade', version: '0.1.0' }
      }), exited])
      const mcp = options.mcp()
      const http = init.agentCapabilities?.mcpCapabilities?.http === true
      const mcpServers: McpServer[] = mcp.url && http ? [{ type: 'http', name: 'cascade', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }] : []
      const _meta = providerId === 'claude' && mcpServers.length ? { claudeCode: { options: { allowedTools: READ_ONLY_TOOLS } } } : undefined
      const session = await Promise.race([chat.connection.agent.request('session/new', { cwd: dir, mcpServers, ...(_meta ? { _meta } : {}) }), exited])
      chat.sessionId = session.sessionId
      const info = init.agentInfo
      return { id, providerId, agent: info ? `${info.title ?? info.name} ${info.version}` : launcher.name, options: session.configOptions ?? [], cascadeTools: mcpServers.length > 0 }
    } catch (error) {
      await close(id)
      throw new Error(friendly(error, launcher))
    }
  }

  async function prompt(id: string, text: string): Promise<StopReason> {
    const chat = get(id)
    const blocks = [{ type: 'text' as const, text: chat.primed ? text : `${CONTEXT}\n\n${text}` }]
    chat.primed = true
    const response = await chat.connection.agent.request<PromptResponse, PromptRequest>('session/prompt', { sessionId: chat.sessionId, prompt: blocks })
    return response.stopReason
  }

  async function cancel(id: string) {
    const chat = get(id)
    for (const finish of chat.permissions.values()) finish({ outcome: { outcome: 'cancelled' } })
    await chat.connection.agent.notify('session/cancel', { sessionId: chat.sessionId })
  }

  async function setOption(id: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const chat = get(id)
    const params: SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId: chat.sessionId, configId, type: 'boolean' as const, value }
      : { sessionId: chat.sessionId, configId, value }
    const response = await chat.connection.agent.request<SetSessionConfigOptionResponse, SetSessionConfigOptionRequest>('session/set_config_option', params)
    options.emit({ chatId: id, type: 'options', options: response.configOptions })
    return response.configOptions
  }

  async function respond(id: string, requestId: string, optionId: string | null) {
    const finish = get(id).permissions.get(requestId)
    finish?.(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
  }

  async function close(id: string) {
    const chat = chats.get(id)
    if (!chat) return
    chats.delete(id)
    for (const finish of chat.permissions.values()) finish({ outcome: { outcome: 'cancelled' } })
    chat.connection?.close()
    chat.child.kill('SIGTERM')
    setTimeout(() => { if (chat.child.exitCode === null) chat.child.kill('SIGKILL') }, 3000).unref()
  }

  return { providers, start, prompt, cancel, setOption, respond, close, closeAll: () => Promise.all([...chats.keys()].map(close)) }
}

const lastLines = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400)
function friendly(error: unknown, launcher: AgentLauncher) {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth/i.test(message)) return `${launcher.name} needs you to sign in. Run \`${launcher.id === 'claude' ? 'claude' : launcher.id === 'codex' ? 'codex login' : launcher.command ?? launcher.id}\` in a terminal once, then retry.`
  return message
}

export async function registerAgentsIpc(options: Omit<AgentHostOptions, 'emit'>, send: (event: AgentEvent) => void) {
  const { ipcMain, app } = await import('electron')
  const host = createAgentHost({ ...options, emit: send })
  ipcMain.handle('agents:providers', () => host.providers())
  ipcMain.handle('agents:start', (_e, providerId: string, cwd?: string) => host.start(providerId, cwd))
  ipcMain.handle('agents:prompt', (_e, id: string, text: string) => host.prompt(id, text))
  ipcMain.handle('agents:cancel', (_e, id: string) => host.cancel(id))
  ipcMain.handle('agents:setOption', (_e, id: string, configId: string, value: string | boolean) => host.setOption(id, configId, value))
  ipcMain.handle('agents:respond', (_e, id: string, requestId: string, optionId: string | null) => host.respond(id, requestId, optionId))
  ipcMain.handle('agents:close', (_e, id: string) => host.close(id))
  app.on('before-quit', () => { void host.closeAll() })
  return host
}
