import { expect, test } from 'vitest'
import { LoudnessMeter, sparkline } from './loudness'

const RATE = 48000
function stereo(seconds: number, sample: (t: number) => number) {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) out[i * 2] = out[i * 2 + 1] = sample(i / RATE)
  return out
}

test('a -6 dBFS 1 kHz stereo sine reads -6 dBFS peak and -6 LUFS (BS.1770 calibration)', () => {
  // BS.1770 is calibrated so a 0 dBFS 1 kHz sine on both channels reads 0 LUFS; at half amplitude, -6 LUFS.
  const meter = new LoudnessMeter(stereo(3, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t)), RATE)
  const r = meter.measure()
  expect(r.peak).toBeCloseTo(-6.02, 1)
  expect(r.integrated).toBeCloseTo(-6.02, 0)
  expect(r.clipped).toBe(0)
})

test('clipping is counted and located; silence gates out', () => {
  const meter = new LoudnessMeter(stereo(2, (t) => (t >= 1 && t < 1.1 ? 1 : 0)), RATE)
  const all = meter.measure()
  expect(all.clipped).toBeGreaterThan(0)
  expect(all.clipTimes[0]).toBeCloseTo(1, 2)
  const quiet = meter.measure(0, 0.9)
  expect(quiet.integrated).toBe(-Infinity)
  expect(quiet.peak).toBe(-Infinity)
})

test('silent stretches and the loudness strip show where the mix drops out', () => {
  const meter = new LoudnessMeter(stereo(4, (t) => (t >= 1 && t < 2.5 ? 0 : 0.3 * Math.sin(2 * Math.PI * 440 * t))), RATE)
  const quiet = meter.silences()
  expect(quiet).toHaveLength(1)
  expect(quiet[0][0]).toBeCloseTo(1, 0)
  expect(quiet[0][1]).toBeCloseTo(2.5, 0)
  const strip = sparkline(meter.envelope(0.5))
  expect(strip).toHaveLength(8)
  expect(strip[3]).toBe(' ')
  expect(strip[0]).not.toBe(' ')
})
