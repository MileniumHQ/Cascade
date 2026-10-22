import { describe, expect, it } from 'vitest'
import type { StageAudio } from '@core/plugin-api'
import type { Track } from '@shared/project'
import { StageMixer } from './mixer'

/** Just enough Web Audio to record routing and parameter writes. */
class FakeParam {
  value = 0
  calls: [string, number, number][] = []
  setValueAtTime(v: number, t: number) { this.value = v; this.calls.push(['set', v, t]) }
  setTargetAtTime(v: number, t: number) { this.value = v; this.calls.push(['target', v, t]) }
}
class FakeNode {
  to: FakeNode[] = []
  disconnected = false
  gain = new FakeParam()
  pan = new FakeParam()
  fftSize = 0
  smoothingTimeConstant = 0
  constructor(public kind: string) {}
  connect(n: FakeNode) { this.to.push(n); return n }
  disconnect() { this.disconnected = true }
  getFloatTimeDomainData(b: Float32Array) { b.fill(0.5) }
}
const make = (chunk = false) => {
  const destination = new FakeNode('dest')
  const nodes: FakeNode[] = []
  const context = {
    currentTime: 1,
    createGain: () => nodes[nodes.push(new FakeNode('gain')) - 1],
    createStereoPanner: () => nodes[nodes.push(new FakeNode('pan')) - 1],
    createChannelSplitter: () => nodes[nodes.push(new FakeNode('split')) - 1],
    createAnalyser: () => nodes[nodes.push(new FakeNode('analyser')) - 1]
  }
  const audio = { context, destination, ...(chunk ? { chunk: { start: 0, duration: 1 } } : {}) } as unknown as StageAudio
  return { audio, destination, nodes }
}
const track = (id: string, over: Partial<Track> = {}): Track => ({ id, kind: 'audio', name: id, hidden: false, muted: false, locked: false, clips: [], ...over })

describe('StageMixer', () => {
  it('routes track bus → master → destination', () => {
    const { audio, destination } = make()
    const mixer = new StageMixer(audio)
    const input = mixer.input(track('a')) as unknown as FakeNode
    const pan = input.to[0]
    expect(pan.kind).toBe('pan')
    const master = pan.to[0]
    expect(master.to).toContain(destination)
  })
  it('applies fader, pan and solo to the buses', () => {
    const { audio } = make()
    const mixer = new StageMixer(audio)
    const a = track('a', { gain: -6, pan: -0.5 }), b = track('b', { solo: true })
    mixer.sync([a, b])
    const ina = mixer.input(a) as unknown as FakeNode, inb = mixer.input(b) as unknown as FakeNode
    expect(ina.gain.value).toBe(0) // soloed out
    expect(inb.gain.value).toBe(1)
    expect(ina.to[0].pan.value).toBe(-0.5)
    mixer.sync([{ ...a }, { ...b, solo: false }])
    expect(ina.gain.value).toBeCloseTo(0.501, 3)
    expect(inb.gain.value).toBe(1)
  })
  it('smooths live changes and writes exact values offline', () => {
    const live = make(), off = make(true)
    const l = new StageMixer(live.audio), o = new StageMixer(off.audio)
    const t = track('a', { gain: -6 })
    l.sync([t])
    o.sync([t], 0)
    l.sync([{ ...t, gain: -12 }])
    o.sync([{ ...t, gain: -12 }], 2)
    const lg = (l.input(t) as unknown as FakeNode).gain.calls, og = (o.input(t) as unknown as FakeNode).gain.calls
    expect(lg.at(-1)![0]).toBe('target')
    expect(og.at(-1)).toEqual(['set', expect.closeTo(0.251, 3), 2])
  })
  it('does not rewrite unchanged parameters', () => {
    const { audio } = make()
    const mixer = new StageMixer(audio)
    const t = track('a')
    mixer.sync([t])
    mixer.sync([t])
    expect((mixer.input(t) as unknown as FakeNode).gain.calls).toHaveLength(1)
  })
  it('drops buses of removed tracks and ignores visual tracks', () => {
    const { audio, nodes } = make()
    const mixer = new StageMixer(audio)
    mixer.sync([track('a'), track('v', { kind: 'visual' })])
    const gains = nodes.filter((n) => n.kind === 'gain').length
    expect(gains).toBe(2) // master + one audio bus
    const a = mixer.input(track('a')) as unknown as FakeNode
    mixer.sync([])
    expect(a.disconnected).toBe(true)
  })
  it('meters lazily and only for known channels', () => {
    const { audio, nodes } = make()
    const mixer = new StageMixer(audio)
    mixer.sync([track('a')])
    expect(nodes.some((n) => n.kind === 'analyser')).toBe(false)
    expect(mixer.meter('track:a')).toEqual({ peak: [0.5, 0.5], rms: [0.5, 0.5] })
    expect(mixer.meter('master')).not.toBeNull()
    expect(mixer.meter('track:nope')).toBeNull()
  })
})
