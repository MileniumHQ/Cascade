import { definePlugin, type AudioPropertyNode } from '@core/plugin-api'

const n = (v: unknown) => Number(v) || 0
const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))
const isAudio = (clip: { type: string }) => clip.type === 'audio'

/** Smoothly set an AudioParam (avoids zipper noise in the live preview). */
const ramp = (p: AudioParam, v: number, at: number) => {
  if (Math.abs(p.value - v) < 1e-6) return
  p.setTargetAtTime(v, at, 0.012)
}

/** Web Audio–backed properties for audio clips. */
export const audioPropertiesPlugin = definePlugin({
  id: 'cascade.properties.audio',
  name: 'Audio properties',
  activate(ctx) {
    ctx.properties.register({
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
    ctx.properties.register({
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
    ctx.properties.register({
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
    ctx.properties.register({
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
    ctx.properties.register({
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
  }
})
