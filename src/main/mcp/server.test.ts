import { afterEach, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tools, editSchema } from './catalog'
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
  expect(listed.tools).toHaveLength(41)
  expect(listed.tools[0].inputSchema.required ?? []).not.toContain('detail')
  expect(listed.tools.find(t => t.name === 'timeline_apply_edits')?.annotations?.destructiveHint).toBe(true)
  const progress: number[] = []
  expect((await client.callTool({ name: 'registry_list', arguments: {} }, undefined, { onprogress: p => progress.push(p.progress) })).isError).toBeFalsy()
  expect(progress).toEqual([0, 1])
  const direct = await fetch(started.url, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'legacy-session-header' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }) })
  expect(direct.status).toBe(200)
  const payload = (await direct.text()).split('\n').find(line => line.startsWith('data: '))!
  expect(JSON.parse(payload.slice(6)).result.tools).toHaveLength(41)
  const invalid = await client.callTool({ name: 'frame_get', arguments: { time: -1 } })
  expect(invalid.isError).toBe(true)
  expect(received).toEqual(['registry_list'])
  enabled = false
  expect((await fetch(started.url, { method: 'POST', headers: { Authorization: 'Bearer secret' } })).status).toBe(503)
})

test('new tool schemas retain open registry IDs and reject invalid amounts and fields', () => {
  const parse = (name: string, args: unknown) => tools.find(t => t.name === name)!.schema.safeParse(args).success
  expect(parse('timeline_switch', { timelineId: 'third-party-timeline' })).toBe(true)
  expect(parse('timeline_switch', { timelineId: '' })).toBe(false)
  expect(parse('timeline_get', { timelineId: 'other', start: 'w12.end+80ms', format: 'json' })).toBe(true)
  expect(parse('media_relink', { mediaId: 'm1', path: '/new.mp4' })).toBe(true)
  expect(parse('media_relink', { mediaId: 'm1' })).toBe(false)
  expect(parse('registry_list', { only: ['transitions', 'markerKinds', 'presets', 'timelineTools'] })).toBe(true)
  for (const op of [
    { op: 'add_transition', type: 'plugin.transition', from: 'c1', duration: '12f', ref: 'cut' },
    { op: 'update_transition', transitionId: 'cut', type: 'another.plugin', params: {} },
    { op: 'remove_transition', transitionId: 'cut' },
    { op: 'ripple_trim', clipId: 'c1', edge: 'start', time: 'w12.end' },
    { op: 'roll', clipId: 'c1', edge: 'end', time: '00:00:04.000' },
    { op: 'slip', clipId: 'c1', delta: '-2s' },
    { op: 'slide', clipId: 'c1', delta: '+12f' },
    { op: 'close_gap', trackId: 't1', time: '1s' },
    { op: 'freeze_frame', clipId: 'c1', time: '2s', duration: '500ms', ref: 'still' },
    { op: 'add_marker', time: 0, name: 'Cue', kind: 'plugin.kind', color: '#fff', note: 'Note', duration: '1s', clipId: 'c1', ref: 'cue' },
    { op: 'update_marker', markerId: 'cue', time: '2s', kind: 'plugin.other' },
    { op: 'remove_marker', markerId: 'cue' },
    { op: 'update_track', trackId: 't1', solo: true, gain: -60, pan: 1 },
    { op: 'nest', clipIds: ['c1'], mediaType: 'plugin.media', ref: 'scene' },
    { op: 'break_apart', clipId: 'scene' },
    { op: 'create_timeline', name: 'Other', ref: 'other' },
    { op: 'rename_timeline', timelineId: 'other', name: 'Renamed' },
    { op: 'delete_timeline', timelineId: 'other' },
    { op: 'apply_preset', clipIds: ['c1'], presetId: 'plugin.style' }
  ]) expect(editSchema.safeParse(op).success, JSON.stringify(op)).toBe(true)
  for (const op of [
    { op: 'slip', clipId: 'c1', delta: 0.5 },
    { op: 'slide', clipId: 'c1', delta: 'w12' },
    { op: 'add_transition', type: 'plugin', from: 'c1', align: 'invalid' },
    { op: 'update_track', trackId: 't1', gain: 13 },
    { op: 'update_track', trackId: 't1', pan: -2 },
    { op: 'freeze_frame', clipId: 'c1', time: 0, duration: -1 },
    { op: 'nest', clipIds: [] },
    { op: 'rename_timeline', timelineId: 'other', name: '   ' },
    { op: 'add_marker', time: 0, name: 'Cue', unexpected: true }
  ]) expect(editSchema.safeParse(op).success, JSON.stringify(op)).toBe(false)
})
