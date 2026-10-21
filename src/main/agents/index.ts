// Agent panel host: one ACP agent subprocess per chat, with Cascade's MCP server attached.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, constants, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type AuthMethod, type ClientConnection, type ContentBlock, type LoadSessionRequest, type LoadSessionResponse, type McpServer, type PromptRequest, type PromptResponse, type RequestPermissionResponse, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk'
import { tools as cascadeTools } from '../mcp/catalog'
import type { AgentAttachment, AgentEvent, AgentProvider, KeyProvider, AgentSession, AgentUsage, StartOptions, SessionConfigOption, StopReason } from '../../shared/agents'
import { fetchCursorUsage, opencodeUsage, parseClaudeUsage, parseCodexStatus, parseOpencodeStatsText, readModelCatalog, type ModelCatalog, type OpencodeStats } from './usage'

/**
 * How to launch an agent. `script` = a bundled Node entry run with Electron-as-Node; `registry` = ACP registry id Cascade can download.
 * `native`: env vars naming the adapter's native binaries (module paths, resolved to the unpacked copy). Such scripts run from
 * inside app.asar, where their JS dependencies are; only the binaries need unpacking.
 */
export interface AgentLauncher { id: string; name: string; icon: AgentProvider['icon']; script?: string; native?: Record<string, string>; command?: string; args?: string[]; registry?: string }

export const LAUNCHERS: AgentLauncher[] = [
  // The adapter imports zod, the MCP SDK and more from app.asar; run unpacked it can't find them ("ACP connection closed").
  { id: 'claude', name: 'Claude', icon: 'claude', script: '@agentclientprotocol/claude-agent-acp/dist/index.js', native: { CLAUDE_CODE_EXECUTABLE: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}` } },
  { id: 'codex', name: 'Codex', icon: 'codex', script: '@agentclientprotocol/codex-acp/dist/index.js' },
  { id: 'cursor', name: 'Cursor', icon: 'cursor', command: 'cursor-agent', args: ['acp'], registry: 'cursor' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', command: 'opencode', args: ['acp'], registry: 'opencode' }
]

/** First prompt preamble: what the agent is embedded in and how to reach the editor. */
export const CONTEXT = `[Context from Cascade] You are running inside the agent panel of Cascade, a video editor. The user is looking at the editor next to this chat. The \`cascade\` MCP server controls the open project live (undoable): inspect with timeline_get/project_get, see with frame_get or contact sheets, edit with timeline_apply_edits, analyze speech with media_analyze then transcript_get. Prefer those tools over editing project files on disk. Each user message ends with [Editor: …], the playhead and selected clips at send time (clip ids as in timeline_get), so "here", "this clip" or "from the playhead" refer to them. Keep replies short; the panel is narrow.`

/** Cascade's read-only tools run without asking (Claude Code naming); edits, shell and file writes still ask in manual mode. */
export const READ_ONLY_TOOLS = cascadeTools.filter(t => t.annotations.readOnlyHint).map(t => `mcp__cascade__${t.name}`)

/** GUI launches often miss shell PATH entries (nvm, ~/.local/bin, bun). */
export async function searchPath(home: string, env = process.env.PATH ?? process.env.Path ?? '', platform = process.platform): Promise<string[]> {
  const extra = platform === 'win32'
    ? [process.env.APPDATA && join(process.env.APPDATA, 'npm'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'cursor-agent'), join(home, '.bun/bin'), join(home, '.local/bin'), join(home, '.opencode/bin')].filter((d): d is string => !!d)
    : [join(home, '.local/bin'), join(home, '.bun/bin'), join(home, '.npm-global/bin'), '/usr/local/bin', '/usr/bin']
  const nvm = join(home, '.nvm/versions/node')
  try { for (const v of (await readdir(nvm)).sort().reverse()) extra.push(join(nvm, v, 'bin')) } catch { /* No nvm. */ }
  return [...new Set([...env.split(delimiter).filter(Boolean), ...extra])]
}
/** Windows resolves `opencode` to opencode.exe / opencode.cmd (npm shims) via PATHEXT. */
const EXTENSIONS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']
async function which(command: string, dirs: string[]) {
  for (const dir of dirs) for (const ext of EXTENSIONS) {
    const path = join(dir, command + ext)
    try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path } catch { /* Keep looking. */ }
  }
  return undefined
}
/** Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980); quote for cmd.exe then. */
export function spawnCommand(command: string, args: string[]): [string, string[], { shell: boolean }] {
  if (!/\.(cmd|bat)$/i.test(command)) return [command, args, { shell: false }]
  const quote = (s: string) => /^[\w.:\\/-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`
  return [quote(command), args.map(quote), { shell: true }]
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
  /** Resolve a bundled module path, by default to its app.asar.unpacked copy (overridable for tests). */
  resolve?: (specifier: string, unpacked?: boolean) => string
  /** Node runtime for bundled scripts: Electron with ELECTRON_RUN_AS_NODE. */
  node?: string
  /** Where registry agents are downloaded (`<userData>/agents`). */
  dataDir?: string
  /** ACP registry index (overridable for tests). */
  registryUrl?: string
}

export const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const PLATFORM = `${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
interface RegistryBinary { archive: string; cmd: string; args?: string[]; sha256?: string }
/** Written next to an installed registry agent. */
interface Installed { version: string; command: string; args: string[] }

export function createAgentHost(options: AgentHostOptions) {
  const require = createRequire(import.meta.url)
  // Packaged: native binaries only run from the unpacked copy.
  const resolve = options.resolve ?? ((s: string, unpacked = true) => unpacked ? require.resolve(s).replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked') : require.resolve(s))
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
    // Windows spells it Path; a copied env would carry both keys.
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: dirs.join(delimiter) }
    delete env.ELECTRON_RUN_AS_NODE
    const own = await installed(l)
    if (own) return { command: own.command, args: own.args, env }
    if (l.script) {
      try {
        const native = Object.fromEntries(Object.entries(l.native ?? {}).map(([k, v]) => [k, resolve(v)]))
        return { command: options.node ?? process.execPath, args: [resolve(l.script, !l.native)], env: { ...env, ...native, ELECTRON_RUN_AS_NODE: '1' } }
      } catch { return { error: 'Bundled adapter missing; reinstall Cascade.' } }
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
    const [command, args, shell] = spawnCommand(how.command, how.args)
    const child = spawn(command, args, { cwd: dir, env: how.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...shell })
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
      if (binary.sha256) {
        const hash = createHash('sha256')
        await pipeline(createReadStream(archive), hash)
        if (hash.digest('hex') !== binary.sha256.toLowerCase()) { await rm(archive, { force: true }); throw new Error(`${l.name}'s download is corrupt (checksum mismatch). Try again.`) }
      }
      const tmp = `${dir}.partial`
      await rm(tmp, { recursive: true, force: true })
      await mkdir(tmp, { recursive: true })
      // Windows' bundled tar (bsdtar) also reads zip; it has no unzip.
      if (archive.endsWith('.zip') && process.platform !== 'win32') await run('unzip', ['-oq', archive, '-d', tmp])
      else await run('tar', [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', tmp])
      await rm(dir, { recursive: true, force: true })
      await rename(tmp, dir)
      await rm(archive, { force: true })
      // Keep only this version.
      for (const old of await readdir(root)) if (old !== entry.version && old !== 'installed.json') await rm(join(root, old), { recursive: true, force: true })
      const info: Installed = { version: entry.version, command: join(dir, binary.cmd), args: binary.args ?? [] }
      // Zip archives don't always keep the executable bit.
      if (process.platform !== 'win32') await chmod(info.command, 0o755).catch(() => {})
      await writeFile(join(root, 'installed.json'), JSON.stringify(info, null, 1))
      options.emit({ type: 'install', providerId, received: total || received, total: total || received })
    })().finally(() => installing.delete(providerId))
    installing.set(providerId, job)
    return job
  }

  /** Run one of the agent's local slash commands in a throwaway session (no MCP, temp cwd) and return its reply. */
  async function command(l: AgentLauncher, text: string): Promise<string> {
    const how = await launch(l)
    if ('error' in how) throw new Error(how.error)
    const [cmd, args, shell] = spawnCommand(how.command, how.args)
    const child = spawn(cmd, args, { cwd: tmpdir(), env: how.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...shell })
    let reply = ''
    const connection = client({ name: 'cascade' })
      .onNotification('session/update', ({ params }) => { const u = params.update; if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') reply += u.content.text })
      .onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' as const } }))
      .connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
    const failed = new Promise<never>((_, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`${l.name} exited (${code}).`)))
      setTimeout(() => reject(new Error(`${l.name} didn't answer in time.`)), 30_000).unref()
    })
    try {
      await Promise.race([connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'cascade', title: 'Cascade', version: '0.1.0' } }), failed])
      const session = await Promise.race([connection.agent.request('session/new', { cwd: tmpdir(), mcpServers: [] }), failed])
      await Promise.race([connection.agent.request<PromptResponse, PromptRequest>('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }), failed])
      return reply
    } catch (error) {
      throw new Error(friendly(error, l))
    } finally {
      connection.close()
      child.kill()
    }
  }

  // OpenCode 2.x (`@opencode/cli`) and 1.x (stable releases, the ACP registry build) differ in stats output and
  // credential storage, so commands branch on the major version of whichever binary `launch` picks.
  type Launch = { command: string; args: string[]; env: NodeJS.ProcessEnv }
  const runOpencode = (how: Launch, args: string[], input?: string) => {
    const [cmd, argv, shell] = spawnCommand(how.command, args)
    return output(cmd, argv, how.env, shell.shell, input)
  }
  const opencodeMajors = new Map<string, Promise<number>>()
  async function opencode(): Promise<{ how: Launch; v2: boolean }> {
    const how = await launch(LAUNCHERS.find(x => x.id === 'opencode')!)
    if ('error' in how) throw new Error(how.error)
    let major = opencodeMajors.get(how.command)
    if (!major) {
      // "opencode v2.1.2" (2.x) or "1.19.3" (1.x).
      major = runOpencode(how, ['--version']).then(v => Number(/(\d+)\.\d+/.exec(v)?.[1] ?? 1))
      opencodeMajors.set(how.command, major)
      major.catch(() => opencodeMajors.delete(how.command))
    }
    return { how, v2: await major >= 2 }
  }

  async function opencodeStats(days: number): Promise<OpencodeStats> {
    const { how, v2 } = await opencode()
    // 2.x: --standalone reads the stats without starting OpenCode's background service. 1.x only prints a text report.
    return v2
      ? JSON.parse(await runOpencode(how, ['stats', '--standalone', '--json', '--models', '--days', String(days)])) as OpencodeStats
      : parseOpencodeStatsText(await runOpencode(how, ['stats', '--models', '--days', String(days)]))
  }

  const usageCache = new Map<string, { at: number; usage: Promise<AgentUsage> }>()
  function usage(providerId: string, fresh = false): Promise<AgentUsage> {
    const l = LAUNCHERS.find(x => x.id === providerId)
    if (!l) return Promise.reject(new Error(`Unknown agent ${providerId}`))
    const cached = usageCache.get(providerId)
    if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.usage
    const job = (async (): Promise<AgentUsage> => {
      switch (providerId) {
        case 'claude': return parseClaudeUsage(await command(l, '/usage'))
        case 'codex': return parseCodexStatus(await command(l, '/status'))
        case 'cursor': return fetchCursorUsage(options.home)
        case 'opencode': {
          // One at a time: two OpenCode processes opening a fresh database collide ("database is locked").
          const today = await opencodeStats(0)
          return opencodeUsage(today, await opencodeStats(7), await readModelCatalog(options.home))
        }
        default: throw new Error(`${l.name} doesn't report usage.`)
      }
    })()
    usageCache.set(providerId, { at: Date.now(), usage: job })
    job.catch(() => usageCache.delete(providerId))
    return job
  }

  // OpenCode's /connect without its TUI: providers from the models.dev catalog; keys through `opencode auth` (2.x)
  // or its auth.json (1.x, whose `auth login` is interactive only).
  interface Integration { id: string; connections?: { type: string; id: string }[] }
  const integrations = async (how: Launch) => JSON.parse(await runOpencode(how, ['auth', 'list', '--format', 'json', '--standalone'])) as Integration[]
  const authFile = () => join(process.env.XDG_DATA_HOME || join(options.home, '.local', 'share'), 'opencode', 'auth.json')
  const readAuth = async () => { try { return JSON.parse(await readFile(authFile(), 'utf8')) as Record<string, unknown> } catch { return {} } }
  async function writeAuth(auth: Record<string, unknown>) {
    await mkdir(join(authFile(), '..'), { recursive: true })
    await writeFile(authFile(), JSON.stringify(auth, null, 2), { mode: 0o600 })
  }
  const catalogFallback = async () => { try { return await (await fetch('https://models.dev/api.json')).json() as ModelCatalog } catch { return null } }

  async function keyProviders(providerId: string): Promise<KeyProvider[]> {
    if (providerId !== 'opencode') return []
    const { how, v2 } = await opencode()
    const [catalog, saved] = await Promise.all([
      readModelCatalog(options.home).then(c => c ?? catalogFallback()),
      v2 ? integrations(how).then(list => list.filter(i => i.connections?.length).map(i => i.id)) : readAuth().then(Object.keys)
    ])
    const connected = new Set(saved)
    const list = Object.entries(catalog ?? {}).map(([id, p]) => ({ id, name: p.name ?? id, connected: connected.has(id) }))
    for (const id of connected) if (!list.some(p => p.id === id)) list.push({ id, name: id, connected: true })
    const rank = (p: KeyProvider) => p.connected ? -1 : POPULAR.includes(p.id) ? POPULAR.indexOf(p.id) : POPULAR.length
    return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }

  async function saveKey(providerId: string, target: string, key: string) {
    if (providerId !== 'opencode') throw new Error('This agent manages its own sign-in.')
    if (!key.trim()) throw new Error('Paste an API key.')
    const { how, v2 } = await opencode()
    if (!v2) return writeAuth({ ...await readAuth(), [target]: { type: 'api', key: key.trim() } })
    const old = (await integrations(how)).find(i => i.id === target)?.connections?.filter(c => c.type === 'credential') ?? []
    const credential = { id: `cred_${randomUUID().replace(/-/g, '')}`, integrationID: target, label: 'API key', active: true, value: { type: 'key', key: key.trim() } }
    // The key goes over stdin, never argv.
    await runOpencode(how, ['auth', 'import', '--standalone'], JSON.stringify([credential]))
    // Replace, don't stack: the new key becomes active once the old ones are gone.
    for (const c of old) await runOpencode(how, ['auth', 'logout', target, c.id, '--standalone'])
  }

  async function removeKey(providerId: string, target: string) {
    if (providerId !== 'opencode') return
    const { how, v2 } = await opencode()
    if (!v2) { const auth = await readAuth(); delete auth[target]; return writeAuth(auth) }
    for (const c of (await integrations(how)).find(i => i.id === target)?.connections ?? []) await runOpencode(how, ['auth', 'logout', target, c.id, '--standalone'])
  }

  return { providers, start, prompt, cancel, setOption, respond, close, install, usage, keyProviders, saveKey, removeKey, closeAll: () => Promise.all([...chats.keys()].map(close)) }
}

const authRequired = (error: unknown) => (error as { code?: number })?.code === -32000 || /auth/i.test(String((error as Error)?.message ?? error))
/** Methods the agent completes itself (browser login), not env-var / terminal / API-key ones (Codex lists `api-key` first, untyped). */
const interactive = (m: AuthMethod) => {
  const type = (m as { type?: string }).type
  return (type === undefined || type === 'agent') && !(m._meta && 'api-key' in m._meta)
}

const lastLines = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400)
const LOGIN: Record<string, string> = { claude: 'claude', codex: 'codex login', cursor: 'cursor-agent login', opencode: 'opencode auth login' }
/** Listed first in OpenCode's provider picker, after the connected ones. */
const POPULAR = ['opencode', 'opencode-go', 'anthropic', 'openai', 'google', 'openrouter', 'xai', 'deepseek', 'groq', 'mistral']
function friendly(error: unknown, launcher: AgentLauncher) {
  const message = error instanceof Error ? error.message : String(error)
  // ACP errors put the useful part (e.g. a login link) in data.message.
  const detail = (error as { data?: { message?: unknown; details?: unknown } })?.data
  const extra = typeof detail?.message === 'string' ? detail.message : typeof detail?.details === 'string' ? detail.details : ''
  if (authRequired(error) && !extra && launcher.id === 'opencode') return 'OpenCode needs a model provider. Connect one with the key button in the model picker.'
  if (authRequired(error) && !extra) return `${launcher.name} needs you to sign in. Run \`${LOGIN[launcher.id] ?? launcher.command ?? launcher.id}\` in a terminal once, then retry.`
  return extra ? `${launcher.name}: ${extra}` : message
}

function output(command: string, args: string[], env: NodeJS.ProcessEnv, shell: boolean, input?: string) {
  return new Promise<string>((done, fail) => {
    const child = spawn(command, args, { env, shell, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 })
    if (input !== undefined) child.stdin!.end(input)
    let out = '', err = ''
    child.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr!.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-1000) })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done(out) : fail(new Error(`${command} failed: ${lastLines(err) || code}`)))
  })
}

function run(command: string, args: string[]) {
  return new Promise<void>((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
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
  ipcMain.handle('agents:usage', (_e, providerId: string, fresh?: boolean) => host.usage(providerId, fresh))
  ipcMain.handle('agents:keyProviders', (_e, providerId: string) => host.keyProviders(providerId))
  ipcMain.handle('agents:saveKey', (_e, providerId: string, target: string, key: string) => host.saveKey(providerId, target, key))
  ipcMain.handle('agents:removeKey', (_e, providerId: string, target: string) => host.removeKey(providerId, target))
  app.on('before-quit', () => { void host.closeAll() })
  return host
}
