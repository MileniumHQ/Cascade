// Run with scripts/drive.mjs after building. Uses the actual installed MCP SDK.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const F = 705600000
export default async ({ win, shot, sleep }) => {
  await win.waitForFunction(() => window.cascadeApp?.services.has('session'))
  const info = await win.evaluate(() => window.cascadeApp.host.info())
  const client = new Client({ name: 'cascade-e2e', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${info.mcp.token}` } } }))
  const output = []
  const call = async (name, args = {}, allowError = false) => {
    const result = await client.callTool({ name, arguments: args })
    const summary = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
    output.push(`${name}: ${summary.slice(0, 1800)}`)
    console.log(`${name}: ${summary.slice(0, 250)}`)
    if (!allowError) assert(!result.isError, `${name}: ${summary}`)
    return result
  }
  const listed = await client.listTools(); assert.equal(listed.tools.length, 26)
  output.push(`tools=${listed.tools.length}`)
  await call('project_get', {}, true)
  await call('project_new', { name: 'MCP integration' })
  await call('registry_list')
  const imported = await call('media_import', { paths: ['~/wwdc.webm'] })
  const mediaId = JSON.parse(imported.content[0].text)[0].id
  const snapshot = JSON.parse((await call('project_get')).content[0].text)
  const visual = snapshot.tracks.filter(t => t.kind === 'visual')
  await call('timeline_apply_edits', { ops: [
    { op: 'add_clip', mediaId, start: 0, duration: 15 * F, sourceIn: 600 * F, trackId: visual[0].id, ref: 'video' },
    { op: 'add_text', text: 'Cascade · agent edit', start: 0, duration: 10 * F, trackId: visual[1].id, ref: 'title' },
    { op: 'add_keyframe', clipId: 'title', propertyId: 'transform', paramId: 'position', time: 0, value: [-0.3, 0] },
    { op: 'add_keyframe', clipId: 'title', propertyId: 'transform', paramId: 'position', time: 2 * F, value: [0, 0] },
    { op: 'split', clipId: 'video', time: 8 * F, ref: 'right' },
    { op: 'ripple_delete', start: 10 * F, end: 12 * F },
    { op: 'add_marker', time: 2 * F, name: 'Title lands' }
  ] })
  await call('timeline_get')
  const unchanged = await win.evaluate(() => JSON.stringify(window.cascadeApp.project()))
  const invalid = await call('timeline_apply_edits', { ops: [{ op: 'add_text', text: 'Must roll back', start: 0, duration: F }, { op: 'delete', clipId: 'does-not-exist' }] }, true)
  assert(invalid.isError); assert.equal(await win.evaluate(() => JSON.stringify(window.cascadeApp.project())), unchanged)
  await call('history_get')
  const raw = await call('media_contact_sheet', { mediaId, start: 600 * F, end: 615 * F, count: 6, columns: 3 })
  await writeFile('/tmp/cascade-mcp-source-sheet.jpg', Buffer.from(raw.content.find(c => c.type === 'image').data, 'base64'))
  const rendered = await call('contact_sheet', { start: 0, end: 13 * F, count: 6 }, true)
  if (rendered.isError) {
    // Current branch's frame service is a deliberate placeholder. Verify composition with a frame mock.
    await win.evaluate(() => {
      const app = window.cascadeApp, host = app.host
      Object.defineProperty(app, 'host', { value: { ...host, export: { ...host.export, frame: async ({ time, width, height }) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const c = canvas.getContext('2d'); c.fillStyle = '#111113'; c.fillRect(0, 0, width, height)
        c.fillStyle = '#c6f24e'; c.font = `${Math.round(width / 18)}px sans-serif`; c.fillText('Frame service mock', 20, height / 2)
        c.fillStyle = '#eeeeee'; c.fillText(`${(time / 705600000).toFixed(2)} seconds`, 20, height / 2 + 35)
        return canvas.toDataURL('image/png')
      } } }, configurable: true })
    })
    const mocked = await call('contact_sheet', { start: 0, end: 13 * F, count: 6 })
    await writeFile('/tmp/cascade-mcp-contact-sheet-mock.jpg', Buffer.from(mocked.content.find(c => c.type === 'image').data, 'base64'))
    output.push('LIMITATION: real export.frame unavailable; contact_sheet composition verified using frame mock. Raw source sheet uses actual ffmpeg posters.')
  } else await writeFile('/tmp/cascade-mcp-contact-sheet.jpg', Buffer.from(rendered.content.find(c => c.type === 'image').data, 'base64'))
  const docs = await call('plugin_api_docs')
  const code = docs.content[0].text.slice(docs.content[0].text.indexOf('// definePlugin'))
  await call('plugin_write', { name: 'agent-glow', code })
  const registry = await call('registry_list'); assert(registry.content[0].text.includes('agent-glow'))
  const badPlugin = await call('plugin_write', { name: 'bad-plugin', code: 'export default {' }, true)
  assert(badPlugin.isError); await call('plugin_remove', { name: 'bad-plugin' })
  await win.evaluate(() => { window.cascadeApp.playback.seek(705600000 * 3); window.cascadeApp.view.pxPerSecond.set(60) })
  await sleep(1500); await shot('agent-edit')
  await call('timeline_undo'); assert.equal(await win.evaluate(() => window.cascadeApp.duration()), 0)
  await call('timeline_redo'); assert.equal(await win.evaluate(() => window.cascadeApp.duration()), 13 * F)
  for (const [headers, status] of [[{}, 401], [{ Authorization: 'Bearer incorrect' }, 401], [{ Authorization: `Bearer ${info.mcp.token}`, Origin: 'https://evil.example' }, 403]]) assert.equal((await fetch(info.mcp.url, { method: 'POST', headers })).status, status)
  await win.evaluate(async () => { const app = window.cascadeApp; app.settings.set('mcp.enabled', false); await app.host.settings.save(app.settings.values.get()) })
  assert.equal((await fetch(info.mcp.url, { method: 'POST', headers: { Authorization: `Bearer ${info.mcp.token}` } })).status, 503)
  await win.evaluate(async () => { const app = window.cascadeApp; app.settings.set('mcp.enabled', true); await app.host.settings.save(app.settings.values.get()) })
  const stdio = new Client({ name: 'stdio-e2e', version: '1' })
  const env = { ...process.env, CASCADE_USER_DATA: info.paths.userData }; delete env.ELECTRON_RUN_AS_NODE
  await stdio.connect(new StdioClientTransport({ command: resolve('node_modules/electron/dist/electron'), args: ['.', '--no-sandbox', '--mcp-stdio'], env, stderr: 'pipe' }))
  assert.equal((await stdio.listTools()).tools.length, 26)
  const stdioRegistry = await stdio.callTool({ name: 'registry_list', arguments: {} }); assert(!stdioRegistry.isError)
  await stdio.close(); output.push('PASS: stdio proxy SDK tools/list + registry_list; auth 401/403; settings disable 503; undo/redo; atomic rollback; plugin build errors and reload')
  await call('project_save')
  await client.close()
  await writeFile('/tmp/cascade-mcp-verification.txt', output.join('\n\n'))
  console.log('MCP VERIFICATION PASSED')
}
