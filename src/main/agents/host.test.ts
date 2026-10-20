import { afterEach, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createAgentHost, LAUNCHERS, searchPath } from './index'
import type { AgentEvent } from '../../shared/agents'

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
let host: ReturnType<typeof createAgentHost> | undefined
afterEach(async () => { await host?.closeAll() })

function make(events: AgentEvent[]) {
  return createAgentHost({
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
  expect(LAUNCHERS.map(l => l.id)).toEqual(['claude', 'codex', 'opencode', 'gemini'])
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

test('PATH search adds common install locations GUI launches miss', async () => {
  const dirs = await searchPath('/home/someone', '/usr/bin')
  expect(dirs[0]).toBe('/usr/bin')
  expect(dirs).toContain('/home/someone/.local/bin')
  expect(new Set(dirs).size).toBe(dirs.length)
})
