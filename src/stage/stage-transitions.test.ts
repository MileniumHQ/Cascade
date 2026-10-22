import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { ClipFrameState } from '@core/plugin-api'
import type { Clip, Project } from '@shared/project'
import { createProject } from '@shared/project'
import { FLICKS } from '@shared/time'
import { transitionsPlugin } from '../plugins/builtin/transitions'
import { audioPlugin } from '../plugins/builtin/media/audio'
import { Stage } from './stage'

const S = (n: number) => Math.round(n * FLICKS)
/** Deliberately small DOM double: tests stage lifecycles/audio scheduling without launching a browser. */
class ElementDouble {
  style = Object.assign({} as Record<string, any>, {
    setProperty: (k: string, v: string) => { this.style[k] = v },
    getPropertyValue: (k: string) => this.style[k] ?? '',
    removeProperty: (k: string) => { delete this.style[k] }
  })
  dataset: Record<string, string> = {}
  className = ''
  children: ElementDouble[] = []
  parentElement?: ElementDouble
  classList = { add: () => {} }
  constructor(public ownerDocument: Document) {}
  appendChild(el: ElementDouble) { this.children.push(el); el.parentElement = this; return el }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this) }
  setAttribute() {}
  querySelector() { return null }
  querySelectorAll() { return [] }
  get childElementCount() { return this.children.length }
  getBoundingClientRect() { return { width: 1920, height: 1080 } }
}
function documentDouble(): Document {
  const doc = { defaultView: null, fonts: { ready: Promise.resolve() } } as unknown as Document
  Object.assign(doc, { createElement: () => new ElementDouble(doc), createElementNS: () => new ElementDouble(doc), head: new ElementDouble(doc), body: new ElementDouble(doc) })
  return doc
}
function project(kind: 'visual' | 'audio' = 'visual'): Project {
  const p = createProject('Stage transitions'), tr = p.timelines[p.activeTimeline].tracks.find(t => t.kind === kind)!
  p.timelines[p.activeTimeline].tracks = [tr]
  p.media.m = { id: 'm', type: 'test', name: 'source', meta: { duration: S(5), hasAudio: true } }
  tr.clips = ['a', 'b'].map((id, i): Clip => ({ id, type: kind === 'visual' ? 'test' : 'audio', mediaId: 'm', name: id, start: S(4 * i), duration: S(4), sourceIn: S(2), properties: [], data: {} }))
  tr.transitions = [{ id: 'tx', type: kind === 'visual' ? 'cross-dissolve' : 'audio-crossfade', from: 'a', to: 'b', duration: S(2), align: 'center', params: {} }]
  return p
}

test('exact video prepares both sides, composes frame layers, clamps handles, and clears styles', async () => {
  const app = new CascadeApp('render', null, project()), host = new PluginHost(app)
  await host.activate(transitionsPlugin, true)
  const states = new Map<string, ClipFrameState>(), prepared: string[] = []
  app.registries.mediaTypes.register({ id: 'test', name: 'Test', icon: 'film', color: '#fff', track: 'visual', stage: { mount: m => ({ el: m.document.createElement('div'), update: s => { states.set(s.clip.id, s) }, prepare: async s => { prepared.push(s.clip.id) }, dispose() {} }) } }, 'test', false)
  app.registries.properties.register({ id: 'transform-test', name: 'Transform', description: '', icon: 'layers', category: '', params: [], apply: () => ({ transform: ['scale(0.5)'], style: { opacity: '0.6' } }) }, 'test', false)
  app.doc.transact('property', d => { d.timelines[d.activeTimeline].tracks[0].clips[1].properties.push({ id: 'p', type: 'transform-test', enabled: true, params: {} }) })
  const stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'render', mediaUrl: x => x })
  await stage.renderExact(app.project(), app.project().activeTimeline, S(3.5))
  expect(stage.mountedClips()).toEqual(['a', 'b'])
  expect(prepared).toEqual(['a', 'b'])
  expect(states.get('b')!.local).toBe(-S(0.5))
  expect(states.get('b')!.sourceTime).toBeCloseTo(1.5)
  const wrapper = stage.clipElement('b')!, layer = wrapper.parentElement!
  expect(layer.style.opacity).toBe('0.25')
  expect(wrapper.style.opacity).toBe('0.6')
  expect(wrapper.style.transform).toContain('scale(0.5)')
  expect(layer.style.zIndex).toBe('1')
  await stage.renderExact(app.project(), app.project().activeTimeline, S(4.5))
  expect(states.get('a')!.local).toBe(S(4.5))
  expect(states.get('a')!.sourceTime).toBeLessThan(5)
  await stage.renderExact(app.project(), app.project().activeTimeline, S(6))
  expect(layer.style.opacity).toBeUndefined()
  expect(stage.mountedClips()).toEqual(['b'])
  app.doc.transact('hide', d => { d.timelines[d.activeTimeline].tracks[0].hidden = true })
  await stage.renderExact(app.project(), app.project().activeTimeline, S(3.5))
  expect(stage.clipElement('a')).toBeNull()
  expect(stage.clipElement('b')).toBeNull()
  stage.dispose()
})

test('offline audio includes handles in decoding and schedules fading gains without a unity gate', async () => {
  const p = project('audio'), app = new CascadeApp('render', null, p), host = new PluginHost(app)
  await host.activate(transitionsPlugin, true); await host.activate(audioPlugin, true)
  const gains: { value: number; at: number }[][] = [], starts: number[] = [], decoded: number[][] = []
  const context = {
    currentTime: 0, destination: {},
    createGain: () => { const events: { value: number; at: number }[] = []; gains.push(events); return { connect() {}, disconnect() {}, gain: { setValueAtTime: (value: number, at: number) => { events.push({ value, at }) } } } },
    createBufferSource: () => ({ playbackRate: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {}, start: (at: number) => { starts.push(at) } })
  } as unknown as OfflineAudioContext
  const stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'render', mediaUrl: x => x, audio: {
    context, destination: context.destination, chunk: { start: 3, duration: 2 },
    getBuffer: async (_media, start, duration) => { decoded.push([start, duration]); return {} as AudioBuffer }
  } })
  await stage.renderAudioChunk(p, p.activeTimeline, S(3), S(2))
  // a starts at source 5 s, outside this media; b uses its pre-start handle from source 1 s.
  expect(decoded).toEqual([[1, 2]])
  expect(starts).toEqual([0])
  const incoming = gains[3]
  expect(incoming[0]).toEqual({ value: 0, at: 0 })
  expect(incoming.find(e => e.at === 1)?.value).toBeCloseTo(Math.SQRT1_2)
  expect(incoming.at(-1)).toEqual({ value: 0, at: 2 })
  expect(incoming.some(e => e.at === 0 && e.value === 1)).toBe(false)
  stage.dispose()
})

test('reversed preview buffers include transition handles and cannot start after playback stops', async () => {
  const { reverseMap, constantMap } = await import('@core/time-remap')
  const app = new CascadeApp('editor', null)
  await new PluginHost(app).activate(audioPlugin, true)
  const doc = documentDouble()
  Object.assign(doc, { createElement: () => ({ paused: true, addEventListener() {}, pause() {}, removeAttribute() {}, load() {} }) })
  const starts: number[] = [], ranges: number[][] = []
  const node = () => ({ connect() {}, disconnect() {} })
  const buffer = { numberOfChannels: 1, length: 3, sampleRate: 1, duration: 3, getChannelData: () => new Float32Array([1, 2, 3]) } as unknown as AudioBuffer
  let resolve!: (buffer: AudioBuffer) => void
  const pending = new Promise<AudioBuffer>(r => { resolve = r })
  const context = { currentTime: 0, createMediaElementSource: node, createGain: node, createBuffer: () => buffer, createBufferSource: () => ({ ...node(), playbackRate: { value: 1 }, start: (_at: number, offset: number) => { starts.push(offset) }, stop() {} }) } as unknown as AudioContext
  const media = { id: 'm', type: 'audio', name: 'Source', meta: { duration: S(30) } }
  const clip: Clip = { id: 'a', type: 'audio', name: 'a', start: S(4), duration: S(4), sourceIn: S(2), properties: [], data: {} }
  const u = { x: String, y: String, len: String, frame: { width: 1920, height: 1080 } }
  const inst = app.registries.mediaTypes.get('audio')!.stage.mount({ clip, media, project: app.project(), document: doc, mode: 'preview', u, mediaUrl: x => x,
    audio: { context, destination: context.destination, getBuffer: async (_media, start, duration) => { ranges.push([start, duration]); return pending } }
  })
  const state: ClipFrameState = { time: S(3.5), local: -S(0.5), sourceTime: 2.5, playing: true, rate: -1, remap: reverseMap(constantMap(1)), clip, media, project: app.project(), mode: 'preview', extra: {}, u, activeRange: { start: S(3), end: S(9) } }
  inst.update(state)
  inst.update({ ...state, playing: false })
  resolve(buffer)
  await pending; await Promise.resolve(); await Promise.resolve()
  expect(ranges).toEqual([[0, 3]])
  expect(starts).toEqual([])
  inst.update(state)
  await Promise.resolve(); await Promise.resolve()
  expect(starts).toEqual([0.5])
  inst.dispose()
})
