import { definePlugin, type AudioPropertyNode, type PropertyContribution } from '@core/plugin-api'
import type { Clip } from '@shared/project'
import { gateProperty } from './gate'

const n = (v: unknown) => Number(v) || 0
const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))
const isAudio = (clip: { type: string }) => clip.type === 'audio'

/** Smoothly set an AudioParam (avoids zipper noise in the live preview). */
const ramp = (p: AudioParam, v: number, at: number) => {
  if (Math.abs(p.value - v) < 1e-6) return
  p.setTargetAtTime(v, at, 0.012)
}

/**
 * Pitch settings of a clip. By default sped-up audio keeps its pitch (time-stretch); with
 * `matchSpeed` it follows speed like tape. `semitones` shifts on top of either.
 * Read by the audio media type (preview) and the export audio plan.
 */
export function pitchOf(clip: Clip): { semitones: number; matchSpeed: boolean } {
  const p = clip.properties.find((x) => x.type === 'pitch' && x.enabled)
  return { semitones: n(p?.params.semitones?.value), matchSpeed: !!p?.params.matchSpeed?.value }
}

// Delay-line pitch shifter for the live preview: two taps sweeping a 50 ms window, crossfaded.
// Export bakes pitch with ffmpeg rubberband instead, so this is a passthrough offline.
const SHIFTER = `
class CascadePitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }] }
  constructor() { super(); this.n = Math.round(sampleRate * 0.05); this.len = this.n * 2; this.buf = [new Float32Array(this.len), new Float32Array(this.len)]; this.w = 0; this.ph = 0 }
  read(b, d) { let p = this.w - d; while (p < 0) p += this.len; const i = Math.floor(p), f = p - i; return b[i] * (1 - f) + b[(i + 1) % this.len] * f }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0], ratio = params.ratio[0]
    if (!inp.length) return true
    if (Math.abs(ratio - 1) < 1e-4) { for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)]); return true }
    const step = (1 - ratio) / this.n
    for (let i = 0; i < out[0].length; i++) {
      this.ph = (this.ph + step + 1) % 1
      const p2 = (this.ph + 0.5) % 1
      const g1 = 1 - Math.abs(2 * this.ph - 1), g2 = 1 - Math.abs(2 * p2 - 1)
      for (let c = 0; c < out.length; c++) {
        const b = this.buf[c]
        b[this.w] = inp[Math.min(c, inp.length - 1)][i]
        out[c][i] = this.read(b, this.ph * this.n) * g1 + this.read(b, p2 * this.n) * g2
      }
      this.w = (this.w + 1) % this.len
    }
    return true
  }
}
registerProcessor('cascade-pitch', CascadePitch)`
const shifterLoaded = new WeakMap<BaseAudioContext, Promise<void>>()
function loadShifter(ac: BaseAudioContext) {
  let p = shifterLoaded.get(ac)
  if (!p) {
    const url = URL.createObjectURL(new Blob([SHIFTER], { type: 'text/javascript' }))
    p = ac.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    shifterLoaded.set(ac, p)
  }
  return p
}

/** Web Audio–backed properties for audio clips. */
export const audioPropertiesPlugin = definePlugin({
  id: 'cascade.properties.audio',
  name: 'Audio properties',
  activate(ctx) {
    // Registry order is priority, then id: keep the menu in registration order.
    let order = 700
    const register = (p: PropertyContribution) => ctx.properties.register({ priority: order++, ...p })
    register({
      id: 'volume',
      name: 'Volume',
      description: 'Clip loudness in decibels',
      icon: 'volume-2',
      category: 'Audio',
      keywords: ['gain', 'loudness', 'level', 'db', 'fade'],
      appliesTo: isAudio,
      params: [{ id: 'gain', label: 'Volume', type: 'number', unit: 'dB', default: 0, min: -60, max: 24, softMin: -40, softMax: 12, step: 0.1 }],
      audio: {
        create(ac, v): AudioPropertyNode {
          const g = ac.createGain()
          g.gain.value = dbToGain(n(v.gain))
          return { input: g, output: g, update: (x, at) => ramp(g.gain, dbToGain(n(x.gain)), at) }
        }
      },
      summary: (v) => `${n(v.gain) > 0 ? '+' : ''}${n(v.gain).toFixed(1)} dB`
    })
    register({
      id: 'pan',
      name: 'Pan',
      description: 'Position in the stereo field',
      icon: 'arrow-left-right',
      category: 'Audio',
      keywords: ['stereo', 'balance', 'left', 'right'],
      appliesTo: isAudio,
      params: [{ id: 'pan', label: 'Pan', type: 'number', unit: 'percent', default: 0, min: -1, max: 1, step: 1 }],
      audio: {
        create(ac, v) {
          const p = ac.createStereoPanner()
          p.pan.value = n(v.pan)
          return { input: p, output: p, update: (x, at) => ramp(p.pan, n(x.pan), at) }
        }
      }
    })
    register({
      id: 'eq',
      name: 'Equalizer',
      description: 'Three-band EQ: low shelf, mid peak, high shelf',
      icon: 'sliders-vertical',
      category: 'Audio',
      keywords: ['bass', 'treble', 'mids', 'tone', 'filter'],
      appliesTo: isAudio,
      params: [
        { id: 'low', label: 'Low', type: 'number', unit: 'dB', default: 0, min: -24, max: 24, step: 0.1 },
        { id: 'mid', label: 'Mid', type: 'number', unit: 'dB', default: 0, min: -24, max: 24, step: 0.1 },
        { id: 'midFreq', label: 'Mid frequency', type: 'number', unit: 'Hz', default: 1000, min: 80, max: 12000, step: 10 },
        { id: 'high', label: 'High', type: 'number', unit: 'dB', default: 0, min: -24, max: 24, step: 0.1 }
      ],
      audio: {
        create(ac, v) {
          const lo = ac.createBiquadFilter()
          lo.type = 'lowshelf'
          lo.frequency.value = 200
          const mid = ac.createBiquadFilter()
          mid.type = 'peaking'
          mid.Q.value = 0.9
          const hi = ac.createBiquadFilter()
          hi.type = 'highshelf'
          hi.frequency.value = 4000
          lo.connect(mid).connect(hi)
          const update = (x: Record<string, unknown>, at: number) => {
            ramp(lo.gain, n(x.low), at)
            ramp(mid.gain, n(x.mid), at)
            ramp(mid.frequency, n(x.midFreq) || 1000, at)
            ramp(hi.gain, n(x.high), at)
          }
          update(v, 0)
          return { input: lo, output: hi, update }
        }
      }
    })
    register({
      id: 'filter',
      name: 'Low/high pass',
      description: 'Cut frequencies above or below a cutoff',
      icon: 'audio-waveform',
      category: 'Audio',
      keywords: ['lowpass', 'highpass', 'muffle', 'telephone', 'cutoff'],
      appliesTo: isAudio,
      stackable: true,
      params: [
        { id: 'type', label: 'Type', type: 'select', default: 'lowpass', config: { segmented: true }, options: [
          { value: 'lowpass', label: 'Low pass' },
          { value: 'highpass', label: 'High pass' }
        ] },
        { id: 'freq', label: 'Cutoff', type: 'number', unit: 'Hz', default: 1200, min: 20, max: 20000, step: 10 },
        { id: 'q', label: 'Resonance', type: 'number', default: 0.7, min: 0.1, max: 20, step: 0.1 }
      ],
      audio: {
        create(ac, v) {
          const f = ac.createBiquadFilter()
          const update = (x: Record<string, unknown>, at: number) => {
            f.type = x.type === 'highpass' ? 'highpass' : 'lowpass'
            ramp(f.frequency, n(x.freq) || 1200, at)
            ramp(f.Q, n(x.q) || 0.7, at)
          }
          update(v, 0)
          return { input: f, output: f, update }
        }
      }
    })
    register({
      id: 'pitch',
      name: 'Pitch',
      description: 'Shift pitch, or let it follow speed',
      icon: 'music',
      category: 'Audio',
      keywords: ['semitone', 'tone', 'key', 'chipmunk', 'tape', 'speed'],
      appliesTo: isAudio,
      params: [
        { id: 'semitones', label: 'Semitones', type: 'number', default: 0, min: -24, max: 24, softMin: -12, softMax: 12, step: 0.1, animatable: false },
        { id: 'matchSpeed', label: 'Match speed', type: 'toggle', default: false }
      ],
      audio: {
        create(ac, v) {
          const io = ac.createGain()
          const out = ac.createGain()
          io.connect(out)
          // Offline (export) audio arrives already pitch-shifted by ffmpeg.
          if (typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext) return { input: io, output: out, update() {} }
          let node: AudioWorkletNode | null = null
          let disposed = false
          const ratio = (x: Record<string, unknown>) => Math.pow(2, n(x.semitones) / 12)
          let last = v
          void loadShifter(ac)
            .then(() => {
              if (disposed) return
              node = new AudioWorkletNode(ac, 'cascade-pitch', { outputChannelCount: [2] })
              node.parameters.get('ratio')!.value = ratio(last)
              io.disconnect()
              io.connect(node).connect(out)
            })
            .catch((e) => console.warn('[pitch] shifter unavailable', e))
          return {
            input: io,
            output: out,
            update(x) {
              last = x
              const r = node?.parameters.get('ratio')
              if (r && Math.abs(r.value - ratio(x)) > 1e-6) r.value = ratio(x)
            },
            dispose() {
              disposed = true
              node?.disconnect()
            }
          }
        }
      },
      summary: (v) => [n(v.semitones) ? `${n(v.semitones) > 0 ? '+' : ''}${+n(v.semitones).toFixed(1)} st` : '', v.matchSpeed ? 'follows speed' : ''].filter(Boolean).join(' · ') || 'Original'
    })
    register({
      id: 'compressor',
      name: 'Compressor',
      description: 'Even out loud and quiet parts',
      icon: 'shrink',
      category: 'Audio',
      keywords: ['dynamics', 'limiter', 'loudness'],
      appliesTo: isAudio,
      params: [
        { id: 'threshold', label: 'Threshold', type: 'number', unit: 'dB', default: -24, min: -100, max: 0, step: 0.5 },
        { id: 'ratio', label: 'Ratio', type: 'number', default: 4, min: 1, max: 20, step: 0.5 },
        { id: 'makeup', label: 'Makeup gain', type: 'number', unit: 'dB', default: 0, min: 0, max: 24, step: 0.1 }
      ],
      audio: {
        create(ac, v) {
          const c = ac.createDynamicsCompressor()
          const g = ac.createGain()
          c.connect(g)
          const update = (x: Record<string, unknown>, at: number) => {
            ramp(c.threshold, n(x.threshold), at)
            ramp(c.ratio, n(x.ratio) || 1, at)
            ramp(g.gain, dbToGain(n(x.makeup)), at)
          }
          update(v, 0)
          return { input: c, output: g, update }
        }
      }
    })
    register(gateProperty)
  }
})
