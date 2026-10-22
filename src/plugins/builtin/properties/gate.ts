import type { AudioPropertyNode, PropertyContribution } from '@core/plugin-api'

/**
 * Noise gate. Live and offline use the same AudioWorklet (the render window renders export audio
 * through an OfflineAudioContext, which supports worklets), so preview and export gate alike.
 *
 * The gate is stereo-linked: a peak follower of both channels opens it above the threshold and
 * closes it 4 dB lower (hysteresis) after a short hold; the gain glides between 1 and `range`.
 */
export interface GateParams {
  /** dB */
  threshold: number
  /** seconds to open */
  attack: number
  /** seconds to close */
  release: number
  /** dB the gate attenuates by while closed (<= -80 is silence) */
  range: number
}

export interface GateCoefs {
  open: number
  close: number
  decay: number
  hold: number
  attack: number
  release: number
  floor: number
}

export interface GateState {
  env: number
  gain: number
  open: boolean
  hold: number
}

export const GATE_HYSTERESIS_DB = 4
export const GATE_HOLD_S = 0.03
export const GATE_DETECTOR_S = 0.005

const lin = (db: number) => (db <= -80 ? 0 : Math.pow(10, db / 20))

export function gateCoefs(p: GateParams, rate: number): GateCoefs {
  const glide = (s: number) => 1 - Math.exp(-1 / (rate * Math.max(s, 1e-4)))
  return {
    open: lin(p.threshold),
    close: lin(p.threshold - GATE_HYSTERESIS_DB),
    decay: Math.exp(-1 / (rate * GATE_DETECTOR_S)),
    hold: Math.round(rate * GATE_HOLD_S),
    attack: glide(p.attack),
    release: glide(p.release),
    floor: lin(p.range)
  }
}

export const createGateState = (): GateState => ({ env: 0, gain: 1, open: true, hold: 0 })

/** Advance one sample (`level` = max |x| over the channels); returns the gain to apply. */
export function gateStep(s: GateState, level: number, c: GateCoefs): number {
  s.env = level > s.env ? level : s.env * c.decay
  if (s.open) {
    if (s.env < c.close) {
      if (s.hold > 0) s.hold--
      else s.open = false
    } else s.hold = c.hold
  } else if (s.env > c.open) {
    s.open = true
    s.hold = c.hold
  }
  const target = s.open ? 1 : c.floor
  s.gain += (target - s.gain) * (target > s.gain ? c.attack : c.release)
  return s.gain
}

// Keep in step with gateCoefs / gateStep above (gate.test.ts runs both on the same signal).
export const GATE_WORKLET = `
class CascadeGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.15, minValue: 0.0001, maxValue: 5, automationRate: 'k-rate' },
      { name: 'range', defaultValue: -80, minValue: -100, maxValue: 0, automationRate: 'k-rate' }
    ]
  }
  constructor() { super(); this.env = 0; this.gain = 1; this.open = true; this.hold = 0 }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0]
    if (!inp.length) return true
    const lin = (db) => (db <= -80 ? 0 : Math.pow(10, db / 20))
    const glide = (s) => 1 - Math.exp(-1 / (sampleRate * Math.max(s, 1e-4)))
    const thr = params.threshold[0]
    const openAt = lin(thr), closeAt = lin(thr - ${GATE_HYSTERESIS_DB}), decay = Math.exp(-1 / (sampleRate * ${GATE_DETECTOR_S}))
    const holdN = Math.round(sampleRate * ${GATE_HOLD_S}), attack = glide(params.attack[0]), release = glide(params.release[0]), floor = lin(params.range[0])
    for (let i = 0; i < out[0].length; i++) {
      let level = 0
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > level) level = v }
      this.env = level > this.env ? level : this.env * decay
      if (this.open) {
        if (this.env < closeAt) { if (this.hold > 0) this.hold--; else this.open = false }
        else this.hold = holdN
      } else if (this.env > openAt) { this.open = true; this.hold = holdN }
      const target = this.open ? 1 : floor
      this.gain += (target - this.gain) * (target > this.gain ? attack : release)
      for (let c = 0; c < out.length; c++) out[c][i] = inp[Math.min(c, inp.length - 1)][i] * this.gain
    }
    return true
  }
}
registerProcessor('cascade-gate', CascadeGate)`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()
function loadGate(ac: BaseAudioContext) {
  let p = loaded.get(ac)
  if (!p) {
    const url = URL.createObjectURL(new Blob([GATE_WORKLET], { type: 'text/javascript' }))
    p = ac.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    loaded.set(ac, p)
  }
  return p
}

const n = (v: unknown) => Number(v) || 0
const NAMES = ['threshold', 'attack', 'release', 'range'] as const
const valueOf = (x: Record<string, unknown>): GateParams => ({
  threshold: Math.min(0, Math.max(-100, Number.isFinite(Number(x.threshold)) ? Number(x.threshold) : -45)),
  attack: Math.max(1e-4, n(x.attack) || 0.005),
  release: Math.max(1e-4, n(x.release) || 0.15),
  range: Math.min(0, Math.max(-100, Number.isFinite(Number(x.range)) ? Number(x.range) : -80))
})

export const gateProperty: Omit<PropertyContribution, 'priority'> = {
  id: 'gate',
  name: 'Noise gate',
  description: 'Silence the clip between the loud parts, e.g. room noise between words',
  icon: 'audio-waveform',
  category: 'Audio',
  keywords: ['noise', 'expander', 'hiss', 'hum', 'silence', 'threshold'],
  appliesTo: (clip: { type: string }) => clip.type === 'audio',
  params: [
    { id: 'threshold', label: 'Threshold', type: 'number', unit: 'dB', default: -45, min: -100, max: 0, softMin: -80, softMax: -10, step: 0.5 },
    { id: 'attack', label: 'Attack', type: 'number', unit: 's', default: 0.005, min: 0.0001, max: 1, softMax: 0.1, step: 0.001 },
    { id: 'release', label: 'Release', type: 'number', unit: 's', default: 0.15, min: 0.0001, max: 5, softMax: 1, step: 0.01 },
    { id: 'range', label: 'Range', type: 'number', unit: 'dB', default: -80, min: -100, max: 0, step: 1 }
  ],
  audio: {
    create(ac, v): AudioPropertyNode {
      const io = ac.createGain()
      const out = ac.createGain()
      io.connect(out)
      const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext
      let node: AudioWorkletNode | null = null
      let disposed = false
      let last = v
      // Offline renders set every automation step before the worklet exists: replay them on arrival.
      const queued: { x: Record<string, unknown>; at: number }[] = [{ x: v, at: 0 }]
      const apply = (x: Record<string, unknown>, at: number) => {
        const value = valueOf(x)
        for (const name of NAMES) {
          const p = node!.parameters.get(name)!
          if (offline) p.setValueAtTime(value[name], at)
          else if (Math.abs(p.value - value[name]) > 1e-9) p.setTargetAtTime(value[name], at, 0.012)
        }
      }
      // Until the module loads (and if it cannot) audio passes through ungated.
      const ready = loadGate(ac)
        .then(() => {
          if (disposed) return
          node = new AudioWorkletNode(ac, 'cascade-gate', { outputChannelCount: [2] })
          if (offline) for (const q of queued) apply(q.x, q.at)
          else apply(last, 0)
          queued.length = 0
          io.disconnect()
          io.connect(node).connect(out)
        })
        .catch((e) => console.warn('[gate] worklet unavailable', e))
      return {
        input: io,
        output: out,
        ready,
        update(x, at) {
          last = x
          if (node) apply(x, at)
          else if (offline) queued.push({ x, at })
        },
        dispose() {
          disposed = true
          node?.disconnect()
        }
      }
    }
  },
  summary: (v) => `${n(v.threshold).toFixed(1)} dB`
}
