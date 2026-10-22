import { afterEach, expect, test, vi } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { ClipFrameState } from '@core/plugin-api'
import { createProject, createTimeline, type Clip } from '@shared/project'
import { FLICKS } from '@shared/time'
import { sequencePlugin } from '../plugins/builtin/sequence'
import { transitionsPlugin } from '../plugins/builtin/transitions'
import { Stage } from './stage'

const S = (n: number) => Math.round(n * FLICKS)
class ElementDouble {
  style = Object.assign({} as Record<string, any>, {
    setProperty: (k: string, v: string) => { this.style[k] = v }, getPropertyValue: (k: string) => this.style[k] ?? '', removeProperty: (k: string) => { delete this.style[k] }
  })
  dataset: Record<string, string> = {}
  className = ''
  id = ''
  children: ElementDouble[] = []
  parentElement?: ElementDouble
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
class Param {
  events: [number, number][] = []
  value = 1
  setValueAtTime(value: number, at: number) { this.events.push([value, at]); this.value = value }
  setTargetAtTime(value: number, at: number) { this.setValueAtTime(value, at) }
}
class NodeDouble {
  gain = new Param()
  pan = new Param()
  connections: NodeDouble[] = []
  buffer?: AudioBuffer
  starts: number[][] = []
  stopped = false
  connect(node: NodeDouble) { this.connections.push(node); return node }
  disconnect() { this.connections = [] }
  start(...args: number[]) { this.starts.push(args) }
  stop() { this.stopped = true }
}
class ContextDouble {
  static all: ContextDouble[] = []
  currentTime = 0
  destination = new NodeDouble()
  nodes: NodeDouble[] = []
  sources: NodeDouble[] = []
  constructor(public channels = 2, public frames = 16, public sampleRate = 4) { ContextDouble.all.push(this) }
  createGain() { const n = new NodeDouble(); this.nodes.push(n); return n }
  createStereoPanner() { const n = new NodeDouble(); this.nodes.push(n); return n }
  createBufferSource() { const n = new NodeDouble(); this.sources.push(n); return n }
  createBuffer(channels: number, frames: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(frames))
    return { numberOfChannels: channels, length: frames, sampleRate, duration: frames / sampleRate, getChannelData: (i: number) => data[i] } as AudioBuffer
  }
  async startRendering() {
    const buffer = this.createBuffer(this.channels, this.frames, this.sampleRate)
    for (let c = 0; c < this.channels; c++) buffer.getChannelData(c).set(Float32Array.from({ length: this.frames }, (_, i) => i + 1))
    return buffer
  }
}
const clip = (id: string, type: string, mediaId: string, start: number, duration: number): Clip => ({ id, type, mediaId, name: id, start: S(start), duration: S(duration), sourceIn: 0, properties: [], data: {} })
async function fixture() {
  const p = createProject('Nested'), child = createTimeline('Child')
  child.id = 'child'
  child.tracks[0].clips = [clip('one', 'toy', 'file', 0, 2), clip('two', 'toy', 'file', 2, 2)]
  child.tracks[0].transitions = [{ id: 'cross', type: 'cross-dissolve', from: 'one', to: 'two', duration: S(2), align: 'center', params: {} }]
  p.timelines.child = child
  p.timelineOrder.push(child.id)
  p.media.file = { id: 'file', type: 'toy', name: 'File', meta: { duration: S(10) } }
  p.media.nested = { id: 'nested', type: 'sequence', name: 'Child', timelineId: child.id, meta: {} }
  const wrapper = clip('wrapper', 'sequence', 'nested', 10, 2)
  wrapper.sourceIn = S(1); wrapper.speed = 2
  p.timelines[p.activeTimeline].tracks[0].clips = [wrapper]
  const app = new CascadeApp('render', null, p), host = new PluginHost(app)
  await host.activate(sequencePlugin, true); await host.activate(transitionsPlugin, true)
  return app
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); ContextDouble.all = [] })

test('nested exact rendering uses remapped source time, child transitions/effects, alpha, and cleans up all resources', async () => {
  const app = await fixture(), states = new Map<string, ClipFrameState>(), prepared: string[] = [], disposed: string[] = []
  app.registries.mediaTypes.register({ id: 'toy', name: 'Toy', icon: 'film', color: '#fff', track: 'visual', stage: { mount: m => ({
    el: m.document.createElement('div'), update: s => { states.set(s.clip.id, s) }, prepare: async s => { prepared.push(s.clip.id) }, dispose: () => { disposed.push(m.clip.id) }
  }) } }, 'toy', false)
  app.registries.properties.register({ id: 'toy-effect', name: 'Toy', description: '', icon: 'film', category: '', params: [], apply: () => ({ style: { opacity: '.6' } }) }, 'toy', false)
  app.doc.transact('effect', d => { d.timelines.child.tracks[0].clips[1].properties = [{ id: 'effect', type: 'toy-effect', enabled: true, params: {} }] })
  const doc = documentDouble(), stage = new Stage({ document: doc, registries: app.registries, mode: 'render', mediaUrl: p => p })
  await stage.renderExact(app.project(), app.project().activeTimeline, S(10.25))
  expect(states.get('one')!.time).toBe(S(1.5))
  expect(states.get('two')!.time).toBe(S(1.5))
  expect(prepared).toEqual(['one', 'two'])
  const wrapper = stage.clipElement('wrapper')!, content = wrapper.children[0] as HTMLElement, root = content.children[0] as HTMLElement
  expect(root.style.background).toBe('transparent')
  const track = root.children[0] as HTMLElement
  const incoming = track.children[1] as HTMLElement
  expect(incoming.style.opacity).toBe('0.25')
  expect((incoming.children[0] as HTMLElement).style.opacity).toBe('.6')
  stage.dispose()
  expect(disposed.sort()).toEqual(['one', 'two'])
  expect(doc.head.childElementCount).toBe(0)
  expect(doc.body.childElementCount).toBe(0)
})

test('a cyclic document renders an empty subtree and warns, while keeping all unknown data', async () => {
  const app = await fixture(), p = structuredClone(app.project())
  p.media.self = { id: 'self', type: 'sequence', name: 'Self', timelineId: p.activeTimeline, meta: {} }
  p.timelines[p.activeTimeline].tracks[0].clips = [clip('recursive', 'sequence', 'self', 0, 4)]
  p.timelines[p.activeTimeline].tracks[0].clips[0].data = { unknown: true }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'render', mediaUrl: p => p })
  await stage.renderExact(p, p.activeTimeline, S(1))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('recursive composition skipped'))
  expect(p.timelines[p.activeTimeline].tracks[0].clips[0].data).toEqual({ unknown: true })
  stage.dispose()
})

test('offline nested audio is mixed in its source clock, retimed, gated and routed through the outer clip/track', async () => {
  vi.stubGlobal('OfflineAudioContext', ContextDouble)
  const app = await fixture(), prepared: ClipFrameState[] = []
  app.doc.transact('sound', d => {
    const child = d.timelines.child
    child.tracks[0].clips = []
    child.tracks[3].clips = [clip('sound', 'toy-audio', 'file', 0, 5)]
    child.tracks[3].gain = -6; child.tracks[3].pan = -.4; child.tracks[3].solo = true
    child.tracks[4].clips = [clip('silent', 'toy-audio', 'file', 0, 5)]
    d.timelines[d.activeTimeline].tracks[0].gain = -3
    d.timelines[d.activeTimeline].tracks[0].pan = .2
  })
  app.registries.mediaTypes.register({ id: 'toy-audio', name: 'Sound', icon: 'music', color: '#fff', track: 'audio', stage: { mount: m => ({
    audioOut: m.audio!.context.createGain(), update() {}, prepare: async s => { prepared.push(s) }, dispose() {}
  }) } }, 'toy', false)
  const context = new ContextDouble(2, 16, 4), doc = documentDouble()
  const stage = new Stage({ document: doc, registries: app.registries, mode: 'render', mediaUrl: p => p,
    audio: { context: context as unknown as OfflineAudioContext, destination: context.destination as unknown as AudioNode, chunk: { start: 9, duration: 4 } } })
  await stage.renderAudioChunk(app.project(), app.project().activeTimeline, S(9), S(4))
  expect(prepared.map(s => s.clip.id)).toEqual(['sound'])
  expect(prepared[0]).toMatchObject({ time: S(1), audioOnly: true })
  expect(context.sources[0].starts).toEqual([[1]])
  expect([...context.sources[0].buffer!.getChannelData(0)]).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
  expect(context.nodes.some(n => n.gain.events.some(([v]) => Math.abs(v - Math.pow(10, -3 / 20)) < 1e-6))).toBe(true)
  const nested = ContextDouble.all[1]
  expect(nested.nodes.some(n => n.gain.events.some(([v]) => Math.abs(v - Math.pow(10, -6 / 20)) < 1e-6))).toBe(true)
  expect(nested.nodes.some(n => n.pan.events.some(([v]) => v === -.4))).toBe(true)
  const chain = context.sources[0].connections[0].connections[0]
  expect(chain.gain.events).toContainEqual([0, 0])
  expect(chain.gain.events.at(-1)).toEqual([0, 3])
  stage.dispose()
  expect(doc.head.childElementCount).toBe(0)
})

test('retimed preview schedules bounded mixed PCM and a pause stops it', async () => {
  vi.stubGlobal('OfflineAudioContext', ContextDouble)
  const app = await fixture()
  app.doc.transact('sound', d => { d.timelines.child.tracks[0].clips = []; d.timelines.child.tracks[3].clips = [clip('sound', 'toy-audio', 'file', 0, 5)] })
  app.registries.mediaTypes.register({ id: 'toy-audio', name: 'Sound', icon: 'music', color: '#fff', track: 'audio', stage: { mount: m => ({ audioOut: m.audio!.context.createGain(), update() {}, async prepare() {}, dispose() {} }) } }, 'toy', false)
  const context = new ContextDouble(), stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'preview', mediaUrl: p => p,
    audio: { context: context as unknown as AudioContext, destination: context.destination as unknown as AudioNode } })
  stage.render(app.project(), app.project().activeTimeline, S(10.25), { playing: true })
  await vi.waitFor(() => expect(context.sources).toHaveLength(1))
  expect(ContextDouble.all[1].frames / ContextDouble.all[1].sampleRate).toBeLessThanOrEqual(4.5)
  stage.render(app.project(), app.project().activeTimeline, S(10.5), { playing: false })
  expect(context.sources[0].stopped).toBe(true)
  stage.dispose()
})

test('an asynchronous retimed preview mix cannot start after pause', async () => {
  vi.stubGlobal('OfflineAudioContext', ContextDouble)
  const app = await fixture(), context = new ContextDouble()
  let resolve!: (buffer: AudioBuffer) => void
  vi.spyOn(ContextDouble.prototype, 'startRendering').mockImplementation(() => new Promise(r => { resolve = r }))
  const stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'preview', mediaUrl: p => p,
    audio: { context: context as unknown as AudioContext, destination: context.destination as unknown as AudioNode } })
  stage.render(app.project(), app.project().activeTimeline, S(10.25), { playing: true })
  await vi.waitFor(() => expect(resolve).toBeDefined())
  stage.render(app.project(), app.project().activeTimeline, S(10.5), { playing: false })
  resolve(context.createBuffer(2, 32, 4))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(context.sources).toHaveLength(0)
  stage.dispose()
})

test('a seek invalidates a pending retimed preview mix without starting another concurrent decode', async () => {
  vi.stubGlobal('OfflineAudioContext', ContextDouble)
  const app = await fixture(), context = new ContextDouble()
  let resolve!: (buffer: AudioBuffer) => void
  const render = vi.spyOn(ContextDouble.prototype, 'startRendering').mockImplementation(() => new Promise(r => { resolve = r }))
  const stage = new Stage({ document: documentDouble(), registries: app.registries, mode: 'preview', mediaUrl: p => p,
    audio: { context: context as unknown as AudioContext, destination: context.destination as unknown as AudioNode } })
  stage.render(app.project(), app.project().activeTimeline, S(10.25), { playing: true })
  await vi.waitFor(() => expect(resolve).toBeDefined())
  stage.render(app.project(), app.project().activeTimeline, S(11), { playing: true })
  expect(render).toHaveBeenCalledTimes(1)
  resolve(context.createBuffer(2, 32, 4))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(context.sources).toHaveLength(0)
  stage.dispose()
})

test('two instances of one timeline scope property and transition SVG filters independently', async () => {
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  const app = await fixture()
  app.registries.mediaTypes.register({ id: 'toy', name: 'Toy', icon: 'film', color: '#fff', track: 'visual', stage: { mount: m => ({ el: m.document.createElement('div'), update() {}, dispose() {} }) } }, 'toy', false)
  app.registries.properties.register({ id: 'svg-property', name: 'SVG', description: '', icon: 'film', category: '', params: [], apply: () => ({ svgFilter: '<feGaussianBlur stdDeviation="1" />' }) }, 'toy', false)
  app.registries.transitions.register({ id: 'svg-transition', name: 'SVG', description: '', icon: 'film', kinds: ['visual'], params: [], apply: () => ({ to: { svgFilter: '<feGaussianBlur stdDeviation="2" />' } }) }, 'toy', false)
  app.doc.transact('repeat', d => {
    const tl = d.timelines[d.activeTimeline]
    tl.tracks[1].clips = [{ ...JSON.parse(JSON.stringify(tl.tracks[0].clips[0])), id: 'second' }]
    d.timelines.child.tracks[0].transitions![0].type = 'svg-transition'
    d.timelines.child.tracks[0].clips[1].properties = [{ id: 'property', type: 'svg-property', enabled: true, params: {} }]
  })
  const doc = documentDouble(), stage = new Stage({ document: doc, registries: app.registries, mode: 'render', mediaUrl: p => p })
  await stage.renderExact(app.project(), app.project().activeTimeline, S(10.25))
  const filters = (id: string) => {
    const content = stage.clipElement(id)!.children[0] as HTMLElement, root = content.children[0] as HTMLElement
    const track = root.children[0] as HTMLElement, layer = track.children[1] as HTMLElement, wrapper = layer.children[0] as HTMLElement
    return [layer.style.filter, wrapper.style.filter]
  }
  const first = filters('wrapper'), second = filters('second')
  expect(first[0]).toContain('txf_stage_')
  expect(first[1]).toContain('f_stage_')
  expect(new Set([...first, ...second]).size).toBe(4)
  stage.dispose()
})
