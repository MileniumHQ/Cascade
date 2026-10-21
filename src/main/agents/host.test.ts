import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createAgentHost, LAUNCHERS, searchPath, spawnCommand } from './index'
import type { AgentEvent } from '../../shared/agents'

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
let host: ReturnType<typeof createAgentHost> | undefined
afterEach(async () => { await host?.closeAll() })

function make(events: AgentEvent[], extra: Partial<Parameters<typeof createAgentHost>[0]> = {}) {
  return createAgentHost({
    ...extra,
    home: tmpdir(), defaultCwd: tmpdir(), mcp: () => ({ url: 'http://127.0.0.1:9/mcp', token: 'tok' }),
    emit: (e) => { events.push(e); if (e.type === 'permission') void host!.respond(e.chatId, e.requestId, 'ok') },
    resolve: () => fixture, node: process.execPath
  })
}

test('drives an ACP agent: session with Cascade MCP attached, streaming, permission relay, options', async () => {
  const events: AgentEvent[] = []
  host = make(events)
  const session = await host.start('claude')
  expect(session).toMatchObject({ providerId: 'claude', agent: 'Fake Agent 1.0', cascadeTools: true })
  expect(session.options[0]).toMatchObject({ id: 'model', currentValue: 'small' })
  expect((await host.setOption(session.id, 'model', 'big'))[0].currentValue).toBe('big')
  expect(await host.prompt(session.id, 'cut the pauses')).toBe('end_turn')
  const text = events.flatMap(e => e.type === 'update' && e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.type === 'text' ? [e.update.content.text] : []).join('')
  const seen = JSON.parse(text.match(/seen=(\{.*?\}) model=/)![1])
  expect(seen.mcp).toEqual([{ type: 'http', name: 'cascade', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok' }] }])
  expect(seen.allowed).toContain('mcp__cascade__timeline_get')
  expect(seen.allowed).not.toContain('mcp__cascade__timeline_apply_edits')
  expect(text).toContain('model=big')
  expect(text).toContain('echo:cut the pauses')
  expect(events.some(e => e.type === 'permission')).toBe(true)
  expect(events.some(e => e.type === 'permission-resolved')).toBe(true)
  const last = events.filter(e => e.type === 'update' && e.update.sessionUpdate === 'tool_call_update').at(-1)
  expect(last?.type === 'update' && last.update.sessionUpdate === 'tool_call_update' && last.update.status).toBe('completed')
  // Only the first prompt carries the Cascade context preamble.
  await host.prompt(session.id, 'again')
})

test('closing a chat ends the process; unknown/missing agents fail clearly', async () => {
  const events: AgentEvent[] = []
  host = make(events)
  const session = await host.start('codex')
  await host.close(session.id)
  await expect(host.prompt(session.id, 'hi')).rejects.toThrow(/chat has ended/)
  await expect(host.start('nope')).rejects.toThrow(/Unknown agent/)
  expect(LAUNCHERS.map(l => l.id)).toEqual(['claude', 'codex', 'cursor', 'opencode'])
})

test('attachments become image / resource_link blocks; resume reloads the session without replaying history', async () => {
  const events: AgentEvent[] = []
  host = make(events)
  const first = await host.start('claude')
  expect(first.images).toBe(true)
  await host.prompt(first.id, 'look', [{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' }])
  const said = () => events.flatMap(e => e.type === 'update' && e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.type === 'text' ? [e.update.content.text] : []).join('')
  expect(said()).toContain('blocks=text,image,resource_link(file:///tmp/notes.txt)')
  await host.close(first.id)
  const again = await host.start('claude', { resume: first.sessionId })
  expect(again).toMatchObject({ resumed: true, sessionId: first.sessionId })
  expect(said()).not.toContain('REPLAY')
  // Resumed sessions are already primed: no second context preamble.
  await host.prompt(again.id, 'more')
  expect(said()).toContain('echo:more')
})

test('a logged-out agent is signed in through its interactive ACP auth method, then the session opens', async () => {
  const events: AgentEvent[] = []
  host = make(events)
  process.env.FAKE_AUTH = '1'
  try {
    const session = await host.start('claude')
    expect(session.sessionId).toBe('s1')
    expect(events.some(e => e.type === 'status' && /signing in/.test(e.message))).toBe(true)
  } finally { delete process.env.FAKE_AUTH }
})

test('registry agents install into dataDir and then launch from there', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cascade-reg-'))
  const pkg = join(work, 'pkg', 'dist-package')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(join(pkg, 'cursor-agent'), 0o755)
  execFileSync('tar', ['czf', join(work, 'agent.tar.gz'), '-C', join(work, 'pkg'), 'dist-package'])
  const server = createServer((req, res) => {
    if (req.url === '/registry.json') {
      const binary = { archive: `http://127.0.0.1:${(server.address() as { port: number }).port}/agent.tar.gz`, cmd: './dist-package/cursor-agent', args: ['acp'] }
      res.end(JSON.stringify({ agents: [{ id: 'cursor', version: '9.9', distribution: { binary: { 'linux-x86_64': binary, 'linux-aarch64': binary, 'darwin-x86_64': binary, 'darwin-aarch64': binary } } }] }))
    } else res.end(readFileSync(join(work, 'agent.tar.gz')))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  try {
    const events: AgentEvent[] = []
    const dataDir = join(work, 'agents')
    host = make(events, { dataDir, registryUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/registry.json` })
    const before = (await host.providers()).find(p => p.id === 'cursor')!
    // Skip if the machine happens to have cursor-agent on PATH.
    if (before.available) return
    expect(before.install).toBeTruthy()
    await host.install('cursor')
    expect((await host.providers()).find(p => p.id === 'cursor')!.available).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'cursor', 'installed.json'), 'utf8')).version).toBe('9.9')
    const session = await host.start('cursor')
    expect(session.agent).toBe('Fake Agent 1.0')
  } finally { server.close() }
})

test('PATH search adds common install locations GUI launches miss', async () => {
  const dirs = await searchPath('/home/someone', '/usr/bin')
  expect(dirs[0]).toBe('/usr/bin')
  expect(dirs).toContain('/home/someone/.local/bin')
  expect(new Set(dirs).size).toBe(dirs.length)
})

test('Windows npm shims (.cmd) spawn through a quoted shell', () => {
  expect(spawnCommand('/usr/bin/opencode', ['acp'])).toEqual(['/usr/bin/opencode', ['acp'], { shell: false }])
  expect(spawnCommand('C:\\Users\\A B\\AppData\\Roaming\\npm\\opencode.cmd', ['acp'])).toEqual(['"C:\\Users\\A B\\AppData\\Roaming\\npm\\opencode.cmd"', ['acp'], { shell: true }])
})

test.skipIf(process.platform === 'win32')('OpenCode 2.x keys: lists catalog providers, replaces a saved key over stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cascade-opencode-'))
  const state = join(dir, 'state.json')
  writeFileSync(state, JSON.stringify({ version: 'opencode v2.1.2', creds: [{ id: 'cred_old', integrationID: 'anthropic' }], argv: [] }))
  // Fake `opencode auth` keeping its credentials in state.json.
  writeFileSync(join(dir, 'fake.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'
const s = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8')); const a = process.argv.slice(2); s.argv.push(a)
if (a[0] === '--version') console.log(s.version)
if (a[1] === 'list') console.log(JSON.stringify([...new Set(s.creds.map(c => c.integrationID))].map(id => ({ id, connections: s.creds.filter(c => c.integrationID === id).map(c => ({ type: 'credential', id: c.id })) }))))
if (a[1] === 'import') s.creds.push(...JSON.parse(readFileSync(0, 'utf8')))
if (a[1] === 'logout') s.creds = s.creds.filter(c => c.id !== a[3])
writeFileSync(${JSON.stringify(state)}, JSON.stringify(s))`)
  writeFileSync(join(dir, 'opencode'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake.mjs')}" "$@"\n`)
  chmodSync(join(dir, 'opencode'), 0o755)
  mkdirSync(join(dir, 'cache/opencode'), { recursive: true })
  writeFileSync(join(dir, 'cache/opencode/models.json'), JSON.stringify({ zai: { name: 'Z.AI' }, anthropic: { name: 'Anthropic' }, openai: { name: 'OpenAI' } }))
  const { PATH: path, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data } = process.env
  process.env.PATH = `${dir}:${path}`
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  try {
    host = make([])
    expect(await host.keyProviders('opencode')).toEqual([
      { id: 'anthropic', name: 'Anthropic', connected: true },
      { id: 'openai', name: 'OpenAI', connected: false },
      { id: 'zai', name: 'Z.AI', connected: false }
    ])
    await host.saveKey('opencode', 'anthropic', ' sk-new \n')
    const s = JSON.parse(readFileSync(state, 'utf8'))
    expect(s.creds).toHaveLength(1)
    expect(s.creds[0]).toMatchObject({ integrationID: 'anthropic', active: true, value: { type: 'key', key: 'sk-new' } })
    expect(JSON.stringify(s.argv)).not.toContain('sk-new')
    await host.removeKey('opencode', 'anthropic')
    expect(JSON.parse(readFileSync(state, 'utf8')).creds).toEqual([])
    expect(await host.keyProviders('claude')).toEqual([])

    // 1.x (stable / registry build): no `auth import`, credentials live in auth.json.
    process.env.XDG_DATA_HOME = join(dir, 'data')
    writeFileSync(state, JSON.stringify({ version: '1.19.3', creds: [], argv: [] }))
    host = make([])
    mkdirSync(join(dir, 'data/opencode'), { recursive: true })
    writeFileSync(join(dir, 'data/opencode/auth.json'), JSON.stringify({ openai: { type: 'oauth', refresh: 'r' } }))
    expect((await host.keyProviders('opencode')).filter(p => p.connected).map(p => p.id)).toEqual(['openai'])
    await host.saveKey('opencode', 'zai', 'sk-zai')
    expect(JSON.parse(readFileSync(join(dir, 'data/opencode/auth.json'), 'utf8'))).toEqual({ openai: { type: 'oauth', refresh: 'r' }, zai: { type: 'api', key: 'sk-zai' } })
    await host.removeKey('opencode', 'openai')
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'data/opencode/auth.json'), 'utf8')))).toEqual(['zai'])
    expect(JSON.parse(readFileSync(state, 'utf8')).argv).toEqual([['--version']])
  } finally {
    process.env.PATH = path
    for (const [k, v] of [['XDG_CACHE_HOME', cache], ['XDG_DATA_HOME', data]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
