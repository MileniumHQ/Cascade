/**
 * Example Cascade plugin: a "Tremolo" audio effect plus a custom meter channel.
 *
 * Audio properties describe a small Web Audio chain (`audio.create`); the stage wires it between
 * the clip's source and its track bus, in the preview and in the offline export render alike.
 * If the node needs async setup (an AudioWorklet module), return `ready` and the export waits for it.
 *
 * `app.meters.provide` adds level taps: anything a plugin can read from the audio graph can show
 * up in meter UIs under its own channel id (the Mixer reads `master` and `track:<id>`).
 */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.tremolo',
  name: 'Tremolo',
  activate(ctx) {
    ctx.properties.register({
      id: 'tremolo',
      name: 'Tremolo',
      description: 'Wobble the volume',
      icon: 'audio-waveform',
      category: 'Audio',
      keywords: ['wobble', 'vibrato', 'lfo'],
      appliesTo: (clip) => clip.type === 'audio',
      params: [
        { id: 'rate', label: 'Rate', type: 'number', unit: 'Hz', default: 5, min: 0.1, max: 30, step: 0.1 },
        { id: 'depth', label: 'Depth', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 }
      ],
      audio: {
        create(ac, v) {
          const gain = ac.createGain()
          const lfo = ac.createOscillator()
          const amount = ac.createGain()
          lfo.connect(amount).connect(gain.gain)
          lfo.start()
          const update = (x: Record<string, unknown>) => {
            const depth = Number(x.depth) || 0
            gain.gain.value = 1 - depth / 2
            amount.gain.value = depth / 2
            lfo.frequency.value = Number(x.rate) || 5
          }
          update(v)
          return { input: gain, output: gain, update, dispose: () => lfo.stop() }
        }
      }
    })

    // A custom meter channel: constant -12 dBFS test tone reading (replace with a real tap).
    const off = ctx.app.meters.provide({ read: (channel) => (channel === 'example.tone' ? { peak: [0.25, 0.25], rms: [0.18, 0.18] } : null) })
    ctx.track({ dispose: off })
  }
}

export default plugin
