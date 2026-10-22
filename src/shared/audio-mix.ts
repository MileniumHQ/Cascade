/**
 * Pure mixing math shared by the stage (buses), exporters and the mixer UI: decibels, pan law,
 * solo resolution and meter ballistics. No Web Audio and no knowledge of specific media types.
 */
import type { Track } from './project'

/** Below this a fader reads as -inf and is silent. */
export const MIN_DB = -60
export const MAX_FADER_DB = 12

export const dbToGain = (db: number) => (db <= MIN_DB ? 0 : Math.pow(10, db / 20))
export const gainToDb = (gain: number) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain))
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Track fader / pan with document defaults applied. */
export const trackGainDb = (t: Pick<Track, 'gain'>) => clamp(Number(t.gain) || 0, MIN_DB, MAX_FADER_DB)
export const trackPan = (t: Pick<Track, 'pan'>) => clamp(Number(t.pan) || 0, -1, 1)

/** True when any audio track is soloed. Solo only concerns audio tracks. */
export const anySolo = (tracks: readonly Pick<Track, 'kind' | 'solo'>[]) => tracks.some((t) => t.kind === 'audio' && !!t.solo)

/** Whether a track contributes to the mix: not muted, and soloed whenever any audio track is. */
export function trackAudible(t: Pick<Track, 'kind' | 'muted' | 'solo'>, soloActive: boolean): boolean {
  if (t.muted) return false
  return t.kind !== 'audio' || !soloActive || !!t.solo
}

/** Bus gain of a track: fader level, or silence when it is muted / soloed out. */
export const busGain = (t: Pick<Track, 'kind' | 'muted' | 'solo' | 'gain'>, soloActive: boolean) => (trackAudible(t, soloActive) ? dbToGain(trackGainDb(t)) : 0)

/** Web Audio's StereoPannerNode law for a stereo input: the output pair for input samples `l`, `r`. Pan 0 is the identity; ±1 folds both channels to one side. */
export function panStereo(pan: number, l: number, r: number): [number, number] {
  const p = clamp(pan, -1, 1)
  const x = (p <= 0 ? p + 1 : p) * (Math.PI / 2)
  return p <= 0 ? [l + r * Math.cos(x), r * Math.sin(x)] : [l * Math.cos(x), r + l * Math.sin(x)]
}

/** Per-channel linear amplitudes over the last analysis window. */
export interface MeterReading {
  peak: [number, number]
  rms: [number, number]
}

export const MASTER_CHANNEL = 'master'
export const trackChannel = (trackId: string) => `track:${trackId}`

/** Peak and RMS of one channel's samples. */
export function measureSamples(samples: ArrayLike<number>): { peak: number; rms: number } {
  let peak = 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    sum += v * v
  }
  return { peak, rms: samples.length ? Math.sqrt(sum / samples.length) : 0 }
}

export const METER_FLOOR_DB = -60
export const CLIP_LEVEL = 0.999
const toDb = (lin: number) => Math.max(METER_FLOOR_DB, gainToDb(lin))

/** Displayed state of one meter, in dB (METER_FLOOR_DB at silence). */
export interface MeterState {
  peak: [number, number]
  rms: [number, number]
  hold: [number, number]
  /** ms since the hold marker last rose. */
  holdAge: [number, number]
  /** Latched until `resetClip`. */
  clip: [boolean, boolean]
}

export const createMeterState = (): MeterState => ({
  peak: [METER_FLOOR_DB, METER_FLOOR_DB],
  rms: [METER_FLOOR_DB, METER_FLOOR_DB],
  hold: [METER_FLOOR_DB, METER_FLOOR_DB],
  holdAge: [0, 0],
  clip: [false, false]
})

export const PEAK_FALL_DB_PER_S = 28
export const HOLD_MS = 1500
export const HOLD_FALL_DB_PER_S = 14
/** One-pole time constants for the RMS bar. */
export const RMS_ATTACK_MS = 60
export const RMS_RELEASE_MS = 300

/**
 * Advance a meter by `dtMs`. Peak jumps up and falls at a fixed rate, RMS is smoothed, the hold
 * marker sits on the loudest recent peak and drops after `HOLD_MS`. A null reading is silence.
 */
export function stepMeter(state: MeterState, reading: MeterReading | null, dtMs: number): MeterState {
  const dt = Math.max(0, dtMs)
  const next = createMeterState()
  for (let c = 0; c < 2; c++) {
    const peakLin = reading ? reading.peak[c] : 0
    const rmsLin = reading ? reading.rms[c] : 0
    const peakDb = toDb(peakLin)
    next.peak[c] = Math.max(peakDb, state.peak[c] - (PEAK_FALL_DB_PER_S * dt) / 1000)
    const target = toDb(rmsLin)
    const tau = target > state.rms[c] ? RMS_ATTACK_MS : RMS_RELEASE_MS
    next.rms[c] = state.rms[c] + (target - state.rms[c]) * (1 - Math.exp(-dt / tau))
    if (peakDb >= state.hold[c]) {
      next.hold[c] = peakDb
      next.holdAge[c] = 0
    } else {
      next.holdAge[c] = state.holdAge[c] + dt
      const over = Math.max(0, next.holdAge[c] - HOLD_MS)
      next.hold[c] = Math.max(peakDb, state.hold[c] - (HOLD_FALL_DB_PER_S * Math.min(dt, over)) / 1000)
    }
    next.clip[c] = state.clip[c] || peakLin >= CLIP_LEVEL
  }
  return next
}

export const resetClip = (state: MeterState): MeterState => ({ ...state, clip: [false, false] })

/** Fader position (0..1) ↔ dB: a gentle curve with more travel near 0 dB, -inf at the bottom. */
const FADER_POWER = 2
export function faderToDb(pos: number): number {
  const p = clamp(pos, 0, 1)
  return MIN_DB + (MAX_FADER_DB - MIN_DB) * (1 - Math.pow(1 - p, FADER_POWER))
}
export function dbToFader(db: number): number {
  const d = clamp(db, MIN_DB, MAX_FADER_DB)
  const f = (d - MIN_DB) / (MAX_FADER_DB - MIN_DB)
  return 1 - Math.pow(1 - f, 1 / FADER_POWER)
}
