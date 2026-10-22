import { expect, test } from 'vitest'
import { CascadeApp } from './app'
import { PluginHost } from './plugin-host'
import { createTimeline, type Clip } from '@shared/project'
import { FLICKS } from '@shared/time'
import { sequencePlugin } from '../plugins/builtin/sequence'
import { timePropertiesPlugin } from '../plugins/builtin/properties/time'
import { audioPlan, rangeHasAudio } from '../plugins/builtin/export-request'
import { compositionAudioRanges } from './media-audio'
import { SourceMonitor } from '../plugins/builtin/panels/source/service'

const S = (n: number) => Math.round(n * FLICKS)
const clip = (id: string, type: string, mediaId: string, start: number, duration: number): Clip => ({ id, type, mediaId, name: id, start: S(start), duration: S(duration), sourceIn: 0, properties: [], data: {} })
async function fixture() {
  const app = new CascadeApp('render', null), host = new PluginHost(app)
  await host.activate(sequencePlugin, true)
  await host.activate(timePropertiesPlugin, true)
  const child = createTimeline('Child')
  child.id = 'child'
  child.tracks[3].clips = [clip('sound', 'audio', 'file', 3, 2)]
  app.doc.transact('fixture', d => {
    d.media.file = { id: 'file', type: 'audio', name: 'Audio', path: '/audio.wav', meta: { duration: S(20), hasAudio: true } }
    d.media.nested = { id: 'nested', type: 'sequence', name: 'Child', timelineId: child.id, meta: {} }
    d.timelines[child.id] = child
    d.timelineOrder.push(child.id)
    const c = clip('wrapper', 'sequence', 'nested', 10, 2)
    c.sourceIn = S(2)
    c.speed = 2
    d.timelines[d.activeTimeline].tracks[0].clips = [c]
  })
  return app
}

test('export detects nested sound through trim/remap and nested mute/solo, including visual hosts', async () => {
  const app = await fixture()
  expect(rangeHasAudio(app, { start: S(10), end: S(10.4) })).toBe(false)
  expect(rangeHasAudio(app, { start: S(10.5), end: S(11.5) })).toBe(true)
  expect(rangeHasAudio(app, { start: S(11.5), end: S(12) })).toBe(false)
  app.doc.transact('mute', d => { d.timelines.child.tracks[3].muted = true })
  expect(rangeHasAudio(app, { start: S(10), end: S(12) })).toBe(false)
  app.doc.transact('solo another', d => { d.timelines.child.tracks[3].muted = false; d.timelines.child.tracks[4].solo = true })
  expect(rangeHasAudio(app, { start: S(10), end: S(12) })).toBe(false)
  app.doc.transact('solo source', d => { d.timelines.child.tracks[3].solo = true })
  expect(rangeHasAudio(app, { start: S(10), end: S(12) })).toBe(true)
  app.doc.transact('mute parent', d => { d.timelines[d.activeTimeline].tracks[0].muted = true })
  expect(rangeHasAudio(app, { start: S(10), end: S(12) })).toBe(false)
})

test('nested PCM plans use source-time scopes and child time maps rather than the active timeline', async () => {
  const app = await fixture()
  app.edit.setActiveTimeline('child')
  const speed = app.edit.addProperty('sound', 'speed')!
  app.edit.setParam('sound', speed, 'speed', 2)
  app.edit.setActiveTimeline(app.project().timelineOrder[0])
  const plan = audioPlan(app, { start: S(10), end: S(12) })
  expect(plan.sound).toMatchObject({ mode: 'stretch', mediaId: 'file', sourceStart: 0, sourceEnd: 4, tempo: 2, localStart: 0 })
  expect(plan.wrapper).toBeUndefined()
  const scopes = compositionAudioRanges(app.project(), app.registries, app.project().activeTimeline, { start: S(10), end: S(12) })
  expect(scopes.map(s => [s.timeline.id, s.range])).toEqual([
    [app.project().activeTimeline, { start: S(10), end: S(12) }], ['child', { start: S(2), end: S(5) }]
  ])
})

test('PCM scopes only include descendants that contribute through the wrapper range, mute and visibility', async () => {
  const app = await fixture(), project = () => app.project(), root = project().activeTimeline
  const ids = (range: { start: number; end: number }) => compositionAudioRanges(project(), app.registries, root, range).map(s => s.timeline.id)
  expect(ids({ start: S(10), end: S(10.4) })).toEqual([root])
  expect(audioPlan(app, { start: S(10), end: S(10.4) }).sound).toBeUndefined()
  expect(compositionAudioRanges(project(), app.registries, root, { start: S(10.5), end: S(11.5) }).map(s => s.range)).toEqual([{ start: S(10.5), end: S(11.5) }, { start: S(3), end: S(5) }])
  app.doc.transact('hide', d => { d.timelines[root].tracks[0].hidden = true })
  expect(ids({ start: S(10), end: S(12) })).toEqual([root])
  app.doc.transact('show+mute', d => { d.timelines[root].tracks[0].hidden = false; d.timelines[root].tracks[0].muted = true })
  expect(ids({ start: S(10), end: S(12) })).toEqual([root])
  expect(audioPlan(app, { start: S(10), end: S(12) }).sound).toBeUndefined()
})

test('a composition used twice merges the ranges each instance needs', async () => {
  const app = await fixture(), root = app.project().activeTimeline
  app.doc.transact('second instance', d => {
    const second = clip('wrapper2', 'sequence', 'nested', 20, 1)
    d.timelines.child.tracks[3].clips.unshift(clip('early', 'audio', 'file', 0, 1))
    d.timelines[root].tracks[0].clips.push(second)
  })
  const scopes = compositionAudioRanges(app.project(), app.registries, root, { start: 0, end: S(30) })
  expect(scopes.map(s => [s.timeline.id, s.range])).toEqual([[root, { start: 0, end: S(30) }], ['child', { start: 0, end: S(5) }]])
})

test('malformed recursion is bounded in audio queries and PCM scopes', async () => {
  const app = await fixture(), p = structuredClone(app.project())
  p.media.cycle = { id: 'cycle', name: 'Cycle', type: 'sequence', timelineId: p.activeTimeline, meta: {} }
  p.timelines.child.tracks[0].clips.push(clip('cycle', 'sequence', 'cycle', 0, 10))
  app.doc.load(p)
  expect(rangeHasAudio(app, { start: S(10), end: S(12) })).toBe(true)
  expect(compositionAudioRanges(p, app.registries, p.activeTimeline, { start: 0, end: S(12) })).toHaveLength(2)
})

test('source monitor retains composition dependencies and rebuilds live lengths', async () => {
  const app = await fixture(), monitor = new SourceMonitor(app)
  app.doc.transact('plugin state', d => { d.pluginData.custom = { keep: true } })
  monitor.open('nested')
  expect(monitor.duration()).toBe(S(5))
  expect(monitor.feed().project().timelines.child).toBeDefined()
  expect(monitor.feed().project().media.file).toBeDefined()
  expect(monitor.feed().project().pluginData.custom).toEqual({ keep: true })
  app.doc.transact('extend source', d => { d.timelines.child.tracks[3].clips[0].duration = S(4) })
  expect(monitor.duration()).toBe(S(7))
  monitor.dispose()
})
