/**
 * The stage's mix graph: every track gets a bus (fader gain + stereo panner) that feeds a master
 * bus, which feeds the audio destination. Clip chains connect to their track's bus. Solo, mute,
 * gain and pan live here, so the preview and the offline export mix identically.
 *
 * Level taps are created lazily, on the first read of a channel, so nothing is analysed while no
 * meter is open.
 */
import type { Id, Track } from '@shared/project'
import { MASTER_CHANNEL, anySolo, busGain, measureSamples, trackChannel, trackPan, type MeterReading } from '@shared/audio-mix'
import type { StageAudio } from '@core/plugin-api'

interface Tap {
  analysers: [AnalyserNode, AnalyserNode]
  buffer: Float32Array<ArrayBuffer>
  splitter: ChannelSplitterNode
}

interface Bus {
  /** Clip chains connect here. */
  input: GainNode
  pan: StereoPannerNode
  tap?: Tap
  gain: number
  panValue: number
}

/** Seconds a live parameter change takes (avoids zipper noise on fader drags). */
const SMOOTH = 0.015

export class StageMixer {
  private buses = new Map<Id, Bus>()
  private master: GainNode
  private masterTap?: Tap
  private offline: boolean

  constructor(private audio: StageAudio) {
    const ctx = audio.context
    this.offline = !!audio.chunk
    this.master = ctx.createGain()
    this.master.connect(audio.destination)
  }

  private makeTap(source: AudioNode): Tap {
    const ctx = this.audio.context
    const splitter = ctx.createChannelSplitter(2)
    source.connect(splitter)
    const analysers = [0, 1].map((c) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      a.smoothingTimeConstant = 0
      splitter.connect(a, c)
      return a
    }) as [AnalyserNode, AnalyserNode]
    return { analysers, splitter, buffer: new Float32Array(analysers[0].fftSize) }
  }

  private read(tap: Tap): MeterReading {
    const peak: [number, number] = [0, 0]
    const rms: [number, number] = [0, 0]
    tap.analysers.forEach((a, c) => {
      a.getFloatTimeDomainData(tap.buffer)
      const m = measureSamples(tap.buffer)
      peak[c] = m.peak
      rms[c] = m.rms
    })
    return { peak, rms }
  }

  /** Latest peak/RMS of `master` or `track:<id>`; null for unknown channels. */
  meter(channel: string): MeterReading | null {
    if (channel === MASTER_CHANNEL) return this.read((this.masterTap ??= this.makeTap(this.master)))
    for (const [id, bus] of this.buses) if (trackChannel(id) === channel) return this.read((bus.tap ??= this.makeTap(bus.pan)))
    return null
  }

  private createBus(track: Track): Bus {
    const ctx = this.audio.context
    const input = ctx.createGain()
    const pan = ctx.createStereoPanner()
    input.connect(pan).connect(this.master)
    const bus: Bus = { input, pan, gain: NaN, panValue: NaN }
    this.buses.set(track.id, bus)
    return bus
  }

  /** The node a track's clip chains connect to. */
  input(track: Track): AudioNode {
    return (this.buses.get(track.id) ?? this.createBus(track)).input
  }

  private set(param: AudioParam, value: number, first: boolean, at: number) {
    if (first || this.offline) param.setValueAtTime(value, first ? 0 : at)
    else param.setTargetAtTime(value, this.audio.context.currentTime, SMOOTH)
  }

  /** Apply fader / pan / solo / mute of the timeline's tracks and drop buses of removed tracks. `at` = context time of the change. */
  sync(tracks: readonly Track[], at = this.audio.context.currentTime) {
    const solo = anySolo(tracks)
    const live = new Set<Id>()
    for (const track of tracks) {
      live.add(track.id)
      if (track.kind !== 'audio' && !this.buses.has(track.id)) continue
      const bus = this.buses.get(track.id) ?? this.createBus(track)
      const gain = busGain(track, solo)
      if (gain !== bus.gain) {
        this.set(bus.input.gain, gain, Number.isNaN(bus.gain), at)
        bus.gain = gain
      }
      const pan = trackPan(track)
      if (pan !== bus.panValue) {
        this.set(bus.pan.pan, pan, Number.isNaN(bus.panValue), at)
        bus.panValue = pan
      }
    }
    for (const [id, bus] of this.buses) {
      if (live.has(id)) continue
      this.teardown(bus)
      this.buses.delete(id)
    }
  }

  private teardown(bus: Bus) {
    for (const n of [bus.input, bus.pan, bus.tap?.splitter, ...(bus.tap?.analysers ?? [])]) {
      try {
        n?.disconnect()
      } catch {}
    }
  }

  dispose() {
    for (const bus of this.buses.values()) this.teardown(bus)
    this.buses.clear()
    for (const n of [this.master, this.masterTap?.splitter, ...(this.masterTap?.analysers ?? [])]) {
      try {
        n?.disconnect()
      } catch {}
    }
  }
}
