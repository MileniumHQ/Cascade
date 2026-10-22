import { describe, expect, it } from 'vitest'
import { GATE_WORKLET, createGateState, gateCoefs, gateStep, type GateParams } from './gate'

const RATE = 8000
const params: GateParams = { threshold: -30, attack: 0.002, release: 0.02, range: -60 }

/** A burst of `amp` for `on` samples between stretches of `floor`. */
function signal(parts: [number, number][]) {
  return Float32Array.from(parts.flatMap(([amp, n]) => Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.9))))
}

function runReference(x: Float32Array, p: GateParams) {
  const s = createGateState()
  const c = gateCoefs(p, RATE)
  return Float32Array.from(x, (v) => v * gateStep(s, Math.abs(v), c))
}

describe('noise gate envelope', () => {
  it('passes loud signal untouched and closes on quiet noise', () => {
    const y = runReference(signal([[0.5, 4000], [0.002, 4000]]), params)
    expect(Math.abs(y[3000])).toBeCloseTo(Math.abs(0.5 * Math.sin(3000 * 0.9)), 3)
    const tail = y.slice(7000)
    expect(Math.max(...tail.map(Math.abs))).toBeLessThan(0.002 * 0.01)
  })
  it('holds before closing so short dips do not chatter', () => {
    const s = createGateState()
    const c = gateCoefs(params, RATE)
    for (let i = 0; i < 400; i++) gateStep(s, 0.5, c)
    // 10 ms of near-silence (hold is 30 ms) keeps the gate open
    for (let i = 0; i < 80; i++) gateStep(s, 0, c)
    expect(s.open).toBe(true)
    for (let i = 0; i < 2000; i++) gateStep(s, 0, c)
    expect(s.open).toBe(false)
  })
  it('uses hysteresis: a level between close and open thresholds keeps the state', () => {
    const c = gateCoefs({ ...params, threshold: -20 }, RATE)
    const between = (c.open + c.close) / 2
    const closed = createGateState()
    closed.open = false
    closed.env = 0
    for (let i = 0; i < 4000; i++) gateStep(closed, between, c)
    expect(closed.open).toBe(false)
    const open = createGateState()
    for (let i = 0; i < 4000; i++) gateStep(open, between, c)
    expect(open.open).toBe(true)
  })
  it('range sets the closed attenuation; 0 dB range never attenuates', () => {
    const s = createGateState()
    const c = gateCoefs({ ...params, range: -20 }, RATE)
    for (let i = 0; i < 20000; i++) gateStep(s, 0, c)
    expect(s.gain).toBeCloseTo(0.1, 3)
    const flat = createGateState()
    const none = gateCoefs({ ...params, range: 0 }, RATE)
    for (let i = 0; i < 20000; i++) gateStep(flat, 0, none)
    expect(flat.gain).toBeCloseTo(1, 6)
  })
  it('attack opens faster than release closes when configured so', () => {
    const c = gateCoefs({ ...params, attack: 0.001, release: 0.5 }, RATE)
    expect(c.attack).toBeGreaterThan(c.release * 10)
  })
})

describe('gate worklet parity', () => {
  it('produces the same output as the reference implementation', () => {
    let Processor: any
    const registerProcessor = (_: string, cls: unknown) => (Processor = cls)
    class AudioWorkletProcessor {}
    // eslint-disable-next-line no-new-func
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', GATE_WORKLET)(AudioWorkletProcessor, registerProcessor, RATE)
    const x = signal([[0.4, 3000], [0.001, 3000], [0.3, 2000], [0.0005, 3000]])
    const expected = runReference(x, params)
    const proc = new Processor()
    const got = new Float32Array(x.length)
    const block = 128
    const k = (v: number) => new Float32Array([v])
    for (let o = 0; o < x.length; o += block) {
      const inp = [[x.slice(o, o + block)]]
      const out = [[new Float32Array(inp[0][0].length)]]
      proc.process(inp, out, { threshold: k(params.threshold), attack: k(params.attack), release: k(params.release), range: k(params.range) })
      got.set(out[0][0], o)
    }
    for (let i = 0; i < x.length; i += 17) expect(got[i]).toBeCloseTo(expected[i], 5)
  })
})
