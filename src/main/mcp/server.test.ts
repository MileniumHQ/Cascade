import { afterEach, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttp } from './server'
import { request, type Server } from 'node:http'
let server: Server | undefined
let client: Client | undefined
afterEach(async () => { await client?.close(); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
test('SDK initialization, tools and direct stateless requests; authorization before execution', async () => {
  const received: string[] = []
  let enabled = true
  const started = await startHttp('secret', async () => enabled, async (tool, args) => { received.push(tool); return { content: [{ type: 'text', text: JSON.stringify(args) }] } }, 0)
  server = started.server
  for (const [headers, status] of [[{}, 401], [{ Authorization: 'Bearer bad' }, 401], [{ Authorization: 'Bearer secret', Origin: 'https://evil.example' }, 403]] as const) expect((await fetch(started.url, { method: 'POST', headers })).status).toBe(status)
  const badHost = await new Promise(resolve => { const req = request(started.url, { method: 'POST', headers: { Host: 'attacker.example', Authorization: 'Bearer secret' } }, res => { res.resume(); resolve(res.statusCode) }); req.end() })
  expect(badHost).toBe(403)
  expect(received).toEqual([])
  client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(started.url), { requestInit: { headers: { Authorization: 'Bearer secret' } } }))
  const listed = await client.listTools()
  expect(listed.tools).toHaveLength(32)
  expect(listed.tools[0].inputSchema.required ?? []).not.toContain('detail')
  expect(listed.tools.find(t => t.name === 'timeline_apply_edits')?.annotations?.destructiveHint).toBe(true)
  const progress: number[] = []
  expect((await client.callTool({ name: 'registry_list', arguments: {} }, undefined, { onprogress: p => progress.push(p.progress) })).isError).toBeFalsy()
  expect(progress).toEqual([0, 1])
  const direct = await fetch(started.url, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'legacy-session-header' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }) })
  expect(direct.status).toBe(200)
  const payload = (await direct.text()).split('\n').find(line => line.startsWith('data: '))!
  expect(JSON.parse(payload.slice(6)).result.tools).toHaveLength(32)
  const invalid = await client.callTool({ name: 'frame_get', arguments: { time: -1 } })
  expect(invalid.isError).toBe(true)
  expect(received).toEqual(['registry_list'])
  enabled = false
  expect((await fetch(started.url, { method: 'POST', headers: { Authorization: 'Bearer secret' } })).status).toBe(503)
})
