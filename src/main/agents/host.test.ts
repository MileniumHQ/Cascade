import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createAgentHost, LAUNCHERS, searchPath } from './index'
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
