// Agent editing features end to end: source transcripts and anchors, linked speed, reverse, repeat/append,
// wiggle, font checks, shot sheets and audio_analyze. Run with scripts/drive.mjs after `bun run build`.
// Needs ~/wwdc.webm and the analysis models in the profile (symlink <profile>/models to a profile that has them).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const F = 705600000
export default async ({ win, shot }) => {
  await win.waitForFunction(() => window.cascadeApp?.services.has('session'))
  const info = await win.evaluate(() => window.cascadeApp.host.info())
  const client = new Client({ name: 'cascade-agent-editing', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${info.mcp.token}` } } }))
  const dir = resolve(process.argv[2] ?? '/tmp/cascade-shots')
  let images = 0
  const call = async (name, args = {}, expectError = false) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })
    const body = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
    for (const c of result.content ?? []) if (c.type === 'image') await writeFile(join(dir, `${name}-${++images}.jpg`), Buffer.from(c.data, 'base64'))
    console.log(`\n── ${name} ${JSON.stringify(args).slice(0, 300)}\n${body.slice(0, 3000)}`)
    assert.equal(!!result.isError, expectError, `${name}: ${body}`)
    return body
  }
  await call('project_new', { name: 'Agent editing e2e' })
  const registry = JSON.parse(await call('registry_list'))
  assert(registry.fonts.length > 5)
  const mediaId = JSON.parse(await call('media_import', { paths: ['~/wwdc.webm'] }))[0].id
  const job = JSON.parse(await call('media_analyze', { mediaId, start: 590 * F, end: 650 * F })).jobId
  assert.match(await call('job_get', { jobId: job, wait: 120 }), /"state": "done"/)

  // Read the source without placing it; pick a sentence by its source anchors.
  const words = await call('transcript_get', { mediaId, view: 'words', start: 600 * F, end: 615 * F, maxLines: 60 })
  const ids = [...words.matchAll(/^\s+(m\d+:w\d+) \S+–\S+ (\S+)/gm)].map(m => m[1])
  assert(ids.length > 8, 'expected words in the source transcript')
  const [, first, , , last] = ids
  const word = ids[6]
  await call('transcript_search', { mediaId, query: words.match(/^\s+m\d+:w\d+ \S+ (\w+)/m)[1] })

  const titles = JSON.parse(await call('project_get')).tracks.filter(t => t.kind === 'visual')[1].id
  const edits = await call('timeline_apply_edits', { ops: [
    { op: 'add_clip', mediaId, start: 0, sourceIn: `${first}.start-40ms`, sourceOut: `${last}.end+60ms`, speed: 1.5, ref: 'line' },
    { op: 'add_clip', mediaId, sourceIn: `${word}.start`, sourceOut: `${word}.end`, repeat: 3, ref: 'stutter' },
    { op: 'add_clip', mediaId, sourceIn: `${first}.start`, sourceOut: `${last}.end`, reverse: true, ref: 'back' },
    { op: 'set_param', clipId: 'stutter.3.audio', propertyId: 'speed', paramId: 'speed', value: 0.6 },
    { op: 'set_param', clipId: 'stutter.2.audio', propertyId: 'volume', paramId: 'gain', value: 10 },
    { op: 'wiggle', clipId: 'back', propertyId: 'transform', paramId: 'position', amplitude: [0.03, 0.02], frequency: 12, seed: 3 },
    { op: 'add_text', text: 'REVERSE', duration: F, trackId: titles }
  ] })
  assert.match(edits, /linked audio c\d+ \(line\.audio\)/)
  assert.match(edits, /\(stutter\.3\.audio\)/)
  const fontError = await call('timeline_apply_edits', { ops: [{ op: 'add_text', text: 'x', start: 0, duration: F, ref: 'font' }, { op: 'set_param', clipId: 'font', propertyId: 'text', paramId: 'font', value: 'Definitely Not A Font' }] }, true)
  assert.match(fontError, /not installed/)
  const timeline = await call('timeline_get')
  assert.match(timeline, /speed 1\.5×/)
  assert.match(timeline, /reversed/)
  assert.match(timeline, /\(from linked clip\)/)
  assert.doesNotMatch(timeline, /opacity\{opacity=1\}/)
  await call('transcript_get', { view: 'words', maxLines: 80 })
  const duration = Number(timeline.match(/duration \S+ \((\d+)\)/)[1])
  await call('contact_sheet', { start: 0, end: Math.min(duration, 2 * F), count: 6 })
  await call('contact_sheet', { mode: 'shots' })
  await call('contact_sheet', { mediaId, mode: 'shots', start: 600 * F, end: 650 * F, count: 9 })
  const back = timeline.match(/^\s+(c\d+) (\S+)–\S+ \[(\d+), (\d+)\) video[^\n]*reversed/m)
  await call('frame_get', { time: Math.round((Number(back[3]) + Number(back[4])) / 2), width: 640 })
  await shot('timeline')
  // Preview: play through the reversed pair (its audio comes from a decoded, reversed buffer).
  await win.evaluate((t) => { const app = window.cascadeApp; app.playback.seek(t); app.playback.play() }, Number(back[3]))
  await new Promise(r => setTimeout(r, 1800))
  const played = await win.evaluate(() => { const app = window.cascadeApp; app.playback.pause(); return app.playback.time.get() })
  assert(played > Number(back[3]) + F / 2, 'playback advanced through the reversed clip')
  await shot('reversed-playing')

  const report = await call('audio_analyze', { transcribe: true, wait: 120 })
  assert.match(report, /LUFS/)
  assert.match(report, /Heard/)
  await writeFile(join(dir, 'audio-analyze.txt'), report)
}
