// Agent panel host: one ACP agent subprocess per chat, with Cascade's MCP server attached.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type AuthMethod, type ClientConnection, type ContentBlock, type LoadSessionRequest, type LoadSessionResponse, type McpServer, type PromptRequest, type PromptResponse, type RequestPermissionResponse, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk'
import { tools as cascadeTools } from '../mcp/catalog'
import type { AgentAttachment, AgentEvent, AgentProvider, AgentSession, StartOptions, SessionConfigOption, StopReason } from '../../shared/agents'

/** How to launch an agent. `script` = a bundled Node entry run with Electron-as-Node; `registry` = ACP registry id Cascade can download. */
export interface AgentLauncher { id: string; name: string; icon: AgentProvider['icon']; script?: string; command?: string; args?: string[]; registry?: string }

export const LAUNCHERS: AgentLauncher[] = [
  { id: 'claude', name: 'Claude Code', icon: 'claude', script: '@agentclientprotocol/claude-agent-acp/dist/index.js' },
  { id: 'codex', name: 'Codex', icon: 'codex', script: '@agentclientprotocol/codex-acp/dist/index.js' },
  { id: 'cursor', name: 'Cursor', icon: 'cursor', command: 'cursor-agent', args: ['acp'], registry: 'cursor' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', command: 'opencode', args: ['acp'] }
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
  images: boolean
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
  /** Where registry agents are downloaded (`<userData>/agents`). */
  dataDir?: string
  /** ACP registry index (overridable for tests). */
  registryUrl?: string
}

export const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const PLATFORM = `${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
interface RegistryBinary { archive: string; cmd: string; args?: string[] }
/** Written next to an installed registry agent. */
interface Installed { version: string; command: string; args: string[] }

export function createAgentHost(options: AgentHostOptions) {
  const require = createRequire(import.meta.url)
  // Packaged: run the unpacked copy so adapters find their native binaries next to them.
  const resolve = options.resolve ?? ((s: string) => require.resolve(s).replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'))
  const chats = new Map<string, Chat>()

  const installedFile = (l: AgentLauncher) => options.dataDir && l.registry ? join(options.dataDir, l.registry, 'installed.json') : null
  async function installed(l: AgentLauncher): Promise<Installed | null> {
    const file = installedFile(l)
    if (!file) return null
    try {
      const info = JSON.parse(await readFile(file, 'utf8')) as Installed
      await access(info.command, constants.X_OK)
      return info
    } catch { return null }
  }

  async function launch(l: AgentLauncher): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string; install?: boolean }> {
    const dirs = await searchPath(options.home)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirs.join(delimiter) }
    delete env.ELECTRON_RUN_AS_NODE
    const own = await installed(l)
    if (own) return { command: own.command, args: own.args, env }
    if (l.script) {
      try { return { command: options.node ?? process.execPath, args: [resolve(l.script)], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } } catch { return { error: 'Bundled adapter missing; reinstall Cascade.' } }
    }
    const path = await which(l.command!, dirs)
    if (path) return { command: path, args: l.args ?? [], env }
    return l.registry && options.dataDir
      ? { error: `${l.name}'s agent isn't installed.`, install: true }
      : { error: `\`${l.command}\` not found on PATH. Install it to use ${l.name}.` }
  }

  async function providers(): Promise<AgentProvider[]> {
    return Promise.all(LAUNCHERS.map(async l => {
      const how = await launch(l)
      if (!('error' in how)) return { id: l.id, name: l.name, icon: l.icon, available: true }
      return { id: l.id, name: l.name, icon: l.icon, available: false, reason: how.error, ...(how.install ? { install: {} } : {}) }
    }))
  }

  const get = (id: string) => {
    const chat = chats.get(id)
    if (!chat) throw new Error('This chat has ended. Start a new one.')
    return chat
  }

  async function start(providerId: string, opts: StartOptions = {}): Promise<AgentSession> {
    const { cwd, resume } = opts
    const launcher = LAUNCHERS.find(l => l.id === providerId)
    if (!launcher) throw new Error(`Unknown agent ${providerId}`)
    const how = await launch(launcher)
    if ('error' in how) throw new Error(how.error)
    const dir = cwd && isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : options.defaultCwd
    const id = randomUUID()
    const child = spawn(how.command, how.args, { cwd: dir, env: how.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const chat = { id, child, sessionId: '', primed: false, images: false, permissions: new Map(), stderr: '' } as unknown as Chat
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
      const extra = _meta ? { _meta } : {}
      chat.images = init.agentCapabilities?.promptCapabilities?.image === true
      let config: SessionConfigOption[] | null | undefined
      let resumed = false
      let resumeError: string | undefined
      if (resume && !init.agentCapabilities?.loadSession) resumeError = `${launcher.name} can't reload earlier sessions`
      if (resume && init.agentCapabilities?.loadSession) {
        // sessionId stays unset while loading, so the replayed history isn't re-emitted.
        const loaded = await Promise.race([chat.connection.agent.request<LoadSessionResponse, LoadSessionRequest>('session/load', { sessionId: resume, cwd: dir, mcpServers, ...extra }), exited]).catch((error: unknown) => { resumeError = error instanceof Error ? error.message : String(error); return null })
        if (loaded) { chat.sessionId = resume; config = loaded.configOptions; resumed = true; chat.primed = true }
      }
      if (!resumed) {
        const open = () => Promise.race([chat.connection.agent.request('session/new', { cwd: dir, mcpServers, ...extra }), exited])
        let session: Awaited<ReturnType<typeof open>>
        try { session = await open() } catch (error) {
          // Agents that need a login offer ACP auth methods; interactive ones open the browser and resolve once done.
          const method = authRequired(error) ? (init.authMethods ?? []).find(interactive) : undefined
          if (!method) throw error
          options.emit({ type: 'status', providerId, message: `Finish signing in to ${launcher.name} in your browser…` })
          await Promise.race([chat.connection.agent.request('authenticate', { methodId: method.id }), exited])
          options.emit({ type: 'status', providerId, message: '' })
          session = await open()
        }
        chat.sessionId = session.sessionId
        config = session.configOptions
      }
      const info = init.agentInfo
      return { id, providerId, agent: info ? `${info.title ?? info.name} ${info.version}` : launcher.name, options: config ?? [], cascadeTools: mcpServers.length > 0, sessionId: chat.sessionId, cwd: dir, resumed, ...(resumeError ? { resumeError } : {}), images: chat.images }
    } catch (error) {
      await close(id)
      throw new Error(friendly(error, launcher))
    }
  }

  async function prompt(id: string, text: string, attachments: AgentAttachment[] = []): Promise<StopReason> {
    const chat = get(id)
    const blocks: ContentBlock[] = [{ type: 'text', text: chat.primed ? text : `${CONTEXT}\n\n${text}` }]
    for (const a of attachments) {
      if (a.kind === 'file') blocks.push({ type: 'resource_link', uri: pathToFileURL(a.path).href, name: a.name })
      else if (chat.images) blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
      else blocks.push({ type: 'text', text: `(The user attached an image, ${a.name}, but this agent can't view images.)` })
    }
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

  const installing = new Map<string, Promise<void>>()
  /** Download an agent's official build listed in the ACP registry into dataDir/<registry id>. */
  function install(providerId: string): Promise<void> {
    const l = LAUNCHERS.find(x => x.id === providerId)
    if (!l?.registry || !options.dataDir) return Promise.reject(new Error(`${l?.name ?? providerId} can't be installed from Cascade.`))
    const running = installing.get(providerId)
    if (running) return running
    const job = (async () => {
      const index = await (await fetch(options.registryUrl ?? REGISTRY)).json() as { agents: { id: string; version: string; distribution?: { binary?: Record<string, RegistryBinary> } }[] }
      const entry = index.agents.find(a => a.id === l.registry)
      const binary = entry?.distribution?.binary?.[PLATFORM]
      if (!entry || !binary) throw new Error(`${l.name} has no download for ${PLATFORM}.`)
      const root = join(options.dataDir!, l.registry!)
      const dir = join(root, entry.version)
      await mkdir(root, { recursive: true })
      const response = await fetch(binary.archive)
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
      const total = Number(response.headers.get('content-length')) || 0
      const archive = join(root, `download${binary.archive.endsWith('.zip') ? '.zip' : '.tar.gz'}`)
      let received = 0, last = 0
      const progress = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctrl) {
        received += chunk.length
        if (received - last > 2_000_000) { last = received; options.emit({ type: 'install', providerId, received, total }) }
        ctrl.enqueue(chunk)
      } })
      await pipeline(Readable.fromWeb(response.body.pipeThrough(progress) as import('node:stream/web').ReadableStream), createWriteStream(archive))
      const tmp = `${dir}.partial`
      await rm(tmp, { recursive: true, force: true })
      await mkdir(tmp, { recursive: true })
      await run(archive.endsWith('.zip') ? 'unzip' : 'tar', archive.endsWith('.zip') ? ['-oq', archive, '-d', tmp] : ['xzf', archive, '-C', tmp])
      await rm(dir, { recursive: true, force: true })
      await rename(tmp, dir)
      await rm(archive, { force: true })
      // Keep only this version.
      for (const old of await readdir(root)) if (old !== entry.version && old !== 'installed.json') await rm(join(root, old), { recursive: true, force: true })
      const info: Installed = { version: entry.version, command: join(dir, binary.cmd), args: binary.args ?? [] }
      await writeFile(join(root, 'installed.json'), JSON.stringify(info, null, 1))
      options.emit({ type: 'install', providerId, received: total || received, total: total || received })
    })().finally(() => installing.delete(providerId))
    installing.set(providerId, job)
    return job
  }

  return { providers, start, prompt, cancel, setOption, respond, close, install, closeAll: () => Promise.all([...chats.keys()].map(close)) }
}

const authRequired = (error: unknown) => (error as { code?: number })?.code === -32000 || /auth/i.test(String((error as Error)?.message ?? error))
/** Methods the agent completes itself (browser login), not env-var / terminal ones. */
const interactive = (m: AuthMethod) => { const type = (m as { type?: string }).type; return type === undefined || type === 'agent' }

const lastLines = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400)
const LOGIN: Record<string, string> = { claude: 'claude', codex: 'codex login', cursor: 'cursor-agent login', opencode: 'opencode auth login' }
function friendly(error: unknown, launcher: AgentLauncher) {
  const message = error instanceof Error ? error.message : String(error)
  // ACP errors put the useful part (e.g. a login link) in data.message.
  const detail = (error as { data?: { message?: unknown; details?: unknown } })?.data
  const extra = typeof detail?.message === 'string' ? detail.message : typeof detail?.details === 'string' ? detail.details : ''
  if (authRequired(error) && !extra) return `${launcher.name} needs you to sign in. Run \`${LOGIN[launcher.id] ?? launcher.command ?? launcher.id}\` in a terminal once, then retry.`
  return extra ? `${launcher.name}: ${extra}` : message
}

function run(command: string, args: string[]) {
  return new Promise<void>((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-1000) })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${command} failed: ${err.trim() || code}`)))
  })
}

export async function registerAgentsIpc(options: Omit<AgentHostOptions, 'emit'>, send: (event: AgentEvent) => void) {
  const { ipcMain, app } = await import('electron')
  const host = createAgentHost({ ...options, emit: send })
  ipcMain.handle('agents:providers', () => host.providers())
  ipcMain.handle('agents:start', (_e, providerId: string, opts?: StartOptions) => host.start(providerId, opts))
  ipcMain.handle('agents:prompt', (_e, id: string, text: string, attachments?: AgentAttachment[]) => host.prompt(id, text, attachments))
  ipcMain.handle('agents:cancel', (_e, id: string) => host.cancel(id))
  ipcMain.handle('agents:setOption', (_e, id: string, configId: string, value: string | boolean) => host.setOption(id, configId, value))
  ipcMain.handle('agents:respond', (_e, id: string, requestId: string, optionId: string | null) => host.respond(id, requestId, optionId))
  ipcMain.handle('agents:close', (_e, id: string) => host.close(id))
  ipcMain.handle('agents:install', (_e, providerId: string) => host.install(providerId))
  app.on('before-quit', () => { void host.closeAll() })
  return host
}
