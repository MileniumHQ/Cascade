import { expect, test, vi } from 'vitest'
import type { HostBridge, McpCall } from '@shared/ipc'
import { AgentTools } from './index'
import { primitiveEditor, S } from './test-fixture'
import { describeParams, markerJson } from './inspection'
import { findClip } from '@shared/project'

async function editor(bridge: HostBridge | null = null) {
  const fixture = await primitiveEditor(bridge)
  fixture.app.services.set('session', { screen: () => 'editor', path: () => '/project.cascade' })
  const agent = new AgentTools(fixture.app, fixture.ids)
  const call = async (tool: string, args: McpCall['args'] = {}) => {
    const result = await agent.call({ id: 'test', tool, args })
    const text = result.content.find(c => c.type === 'text')!.text
    return { result, text, json: () => JSON.parse(text) }
  }
  return { ...fixture, agent, call }
}

test('project_get lists all timelines and media references; timeline_get reads another timeline without navigation', async () => {
  const { app, edit, addThree, call, ids } = await editor(), clips = addThree(), active = app.project().activeTimeline
  edit([{ op: 'nest', clipIds: clips, name: 'Nested scene' }])
  const nested = app.timeline().tracks[0].clips[0], timelineId = app.project().media[nested.mediaId!].timelineId!
  const tl = app.project().timelines[timelineId], first = tl.tracks.flatMap(t => t.clips).find(c => c.type === 'video')!
  app.playback.seek(S(2)); app.selection.setClips([nested.id]); app.view.scrollX.set(123)
  const before = app.project(), undo = app.doc.undoLabel
  const project = (await call('project_get')).json()
  expect(project.timelines).toHaveLength(2)
  expect(project.timelines.find((t: any) => t.name === 'Nested scene')).toMatchObject({ active: false, duration: '00:00:12.000', media: [{ id: ids.show(nested.mediaId!, 'm'), type: 'sequence' }] })
  const read = (await call('timeline_get', { timelineId: ids.show(timelineId, 'l'), format: 'json' })).json()
  expect(read).toMatchObject({ name: 'Nested scene', active: false, duration: '00:00:12.000' })
  expect(read.tracks.flatMap((t: any) => t.clips)).toHaveLength(6)
  expect((await call('timeline_get', { timelineId, clipId: first.id, format: 'json' })).json().id).toBe(ids.show(first.id, 'c'))
  expect((await call('timeline_get', { timelineId, start: '00:00:04.000', end: '8s' })).text).toContain('Nested scene')
  expect(app.project()).toBe(before)
  expect(app.project().activeTimeline).toBe(active)
  expect(app.playback.time.get()).toBe(S(2))
  expect(app.selection.clips.get()).toEqual([nested.id])
  expect(app.view.scrollX.get()).toBe(123)
  expect(app.doc.undoLabel).toBe(undo)
  expect((await call('timeline_get', { format: 'json' })).json().tracks[0].clips[0].timelineId).toBe(ids.show(timelineId, 'l'))
  expect((await call('timeline_get')).text).toContain(`timeline=${ids.show(timelineId, 'l')}`)
})

test('timeline_switch validates IDs, clears selection and preserves undo history', async () => {
  const { app, call, ids } = await editor(), active = app.project().activeTimeline
  const other = app.edit.createTimeline({ name: 'Other' }), undo = app.doc.undoLabel
  app.selection.setClips(['selected']); app.playback.seek(S(2))
  expect((await call('timeline_switch', { timelineId: 'missing' })).result.isError).toBe(true)
  expect((await call('timeline_switch', { timelineId: ids.show(other, 'l') })).json()).toMatchObject({ name: 'Other' })
  expect(app.project().activeTimeline).toBe(other)
  expect(app.selection.clips.get()).toEqual([])
  expect(app.doc.undoLabel).toBe(undo)
  await call('timeline_switch', { timelineId: active })
  expect(app.playback.time.get()).toBe(S(2))
})

test('timeline_get prints transitions, both marker scopes and mixer fields in text and JSON', async () => {
  const { app, edit, call, addThree, ids } = await editor(), [a, b] = addThree()
  const trackId = app.timeline().tracks.find(t => t.kind === 'audio')!.id
  edit([
    { op: 'add_transition', type: 'custom-transition', from: a, to: b, duration: '1s', align: 'start' },
    { op: 'add_marker', time: '500ms', name: 'Chapter', kind: 'custom-kind', duration: '1s', note: 'Notes', color: '#ffffff' },
    { op: 'add_marker', clipId: a, time: '2s', name: 'Source', kind: 'custom-kind', duration: '500ms', color: '#ff0000', note: 'Clip note' },
    { op: 'update_track', trackId, solo: true, gain: -6, pan: 0.25 }
  ])
  const read = (await call('timeline_get', { format: 'json' })).json()
  expect(read.markers[0]).toMatchObject({ kind: 'custom-kind', time: '00:00:00.500', duration: '00:00:01.000', color: '#ffffff', note: 'Notes' })
  expect(read.tracks[0].transitions[0]).toMatchObject({ type: 'custom-transition', from: ids.show(a, 'c'), to: ids.show(b, 'c'), duration: '00:00:01.000', align: 'start' })
  expect(read.tracks[0].clips[0].markers[0]).toMatchObject({ kind: 'custom-kind', time: '00:00:02.000', sourceTime: '00:00:12.000', duration: '00:00:00.500', note: 'Clip note' })
  expect(read.tracks.find((t: any) => t.kind === 'audio')).toMatchObject({ solo: true, gain: -6, pan: 0.25 })
  const printed = (await call('timeline_get')).text
  expect(printed).toContain('custom-transition')
  expect(printed).toContain('duration=00:00:01.000 align=start')
  expect(printed).toContain('solo,gain=-6dB,pan=0.25')
  expect(printed).toContain('note="Clip note"')
  expect((await call('timeline_get', { clipId: a })).text).toContain('Source')
  expect((await call('timeline_get', { format: 'json', trackId: 'missing' })).result.isError).toBe(true)
  expect((await call('timeline_get', { timelineId: 'missing' })).result.isError).toBe(true)
})

test('clip markers report hidden source coordinates and reversed time maps without changing storage', async () => {
  const { app, edit } = await editor()
  edit([{ op: 'add_clip', mediaId: 'footage', start: '2s', sourceIn: '10s', sourceOut: '14s', reverse: true, ref: 'v' }, { op: 'add_marker', clipId: 'v', time: '3s', name: 'Reverse', duration: '500ms' }])
  const clip = app.timeline().tracks[0].clips[0], ids = new AgentTools(app).ids, marker = clip.markers![0]
  expect(marker.t).toBe(S(13))
  expect(markerJson(app, ids, app.timeline(), marker, clip)).toMatchObject({ time: '00:00:03.000', sourceTime: '00:00:13.000' })
  app.edit.trimClip(clip.id, 'start', S(4))
  const trimmed = findClip(app.timeline(), clip.id)!.clip
  expect(markerJson(app, ids, app.timeline(), marker, trimmed)).toMatchObject({ time: null, trimmedOut: true, sourceFlicks: S(13) })
})

test('registry sections discover plugin IDs and document path/curve parameter shapes', async () => {
  const { app, call } = await editor()
  app.registries.properties.register({ id: 'custom-shapes', name: 'Shapes', description: 'Custom shapes', category: 'Test', icon: 'layers', params: [
    { id: 'outline', label: 'Outline', type: 'path', default: { closed: true, points: [] } },
    { id: 'curve', label: 'Curve', type: 'curve', default: {} }
  ], apply: () => ({}) }, 'third-party', false)
  app.registries.timelineTools.register({ id: 'custom-tool', name: 'Custom tool', key: 'F8', icon: 'layers', cursor: 'default', pointerDown() {} }, 'third-party', false)
  const read = (await call('registry_list', { only: ['transitions', 'markerKinds', 'presets', 'timelineTools', 'properties'] })).json()
  expect(read.transitions.find((t: any) => t.id === 'custom-transition')).toMatchObject({ kinds: ['visual'], params: [{ id: 'amount' }] })
  expect(read.markerKinds).toContainEqual({ id: 'custom-kind', name: 'Custom kind', color: '#82cbff' })
  expect(read.presets.find((p: any) => p.id === 'custom-style')).toMatchObject({ kind: 'captions.style', group: 'Third-party' })
  expect(read.timelineTools).toContainEqual({ id: 'custom-tool', name: 'Custom tool', key: 'F8' })
  const params = read.properties.find((p: any) => p.id === 'custom-shapes').params
  expect(params[0].valueShape).toContain('tangents relative')
  expect(params[1].valueShape).toContain('master:')
  expect(describeParams([{ id: 'plain', label: 'Plain', type: 'number', default: 0 }])[0]).not.toHaveProperty('valueShape')
  expect((await call('registry_list', { only: ['invalid'] })).result.isError).toBe(true)
})

test('media_relink returns probe metadata, invalidates proxies, accepts aliases and commits one undo step', async () => {
  const probe = vi.fn(async () => ({ duration: S(30), hasVideo: true, width: 1920, height: 1080 }))
  const { app, call, ids } = await editor({ media: { probe }, info: async () => ({ paths: { home: '/home/test' } }) } as unknown as HostBridge)
  app.doc.transact('Proxy', d => { d.media.footage.proxyPath = '/old-proxy.mp4' })
  const before = app.project()
  const read = await call('media_relink', { mediaId: ids.show('footage', 'm'), path: '~/replacement.mp4' })
  expect(read.result.isError).toBeFalsy()
  expect(probe).toHaveBeenCalledWith('/home/test/replacement.mp4')
  expect(read.json()).toMatchObject({ path: '/home/test/replacement.mp4', duration: '00:00:30.000', durationFlicks: S(30), width: 1920 })
  expect(app.project().media.footage.proxyPath).toBeUndefined()
  expect(app.doc.undoLabel).toBe('Agent: relink media')
  app.doc.undo(); expect(app.project()).toEqual(before)
})

test('media_relink returns probe errors and refuses concurrent project changes', async () => {
  const probe = vi.fn(async () => ({ error: 'File not found' }))
  const { app, call } = await editor({ media: { probe } } as unknown as HostBridge), before = app.project()
  expect((await call('media_relink', { mediaId: 'missing', path: '/replacement.mp4' })).result.isError).toBe(true)
  expect((await call('media_relink', { mediaId: 'footage', path: 'relative.mp4' })).result.isError).toBe(true)
  expect((await call('media_relink', { mediaId: 'footage', path: '/missing.mp4' })).text).toContain('File not found')
  expect(app.project()).toBe(before)
  probe.mockImplementationOnce(async () => { app.edit.renameMedia('footage', 'User renamed'); return {} as { error: string } })
  const changed = await call('media_relink', { mediaId: 'footage', path: '/replacement.mp4' })
  expect(changed.result.isError).toBe(true)
  expect(changed.text).toContain('Project changed during relink')
  expect(app.project().media.footage).toMatchObject({ name: 'User renamed', path: '/footage.mp4' })
})
