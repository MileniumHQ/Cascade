import { expect, test } from 'vitest'
import { detectBeats, toMono } from './beats'

const RATE = 22050

/** Kick + click every beat from `offset`, the first of each bar twice as loud, over light noise. */
function track(bpm: number, seconds: number, offset: number) {
  const out = new Float32Array(Math.round(seconds * RATE))
  let seed = 7
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 }
  for (let i = 0; i < out.length; i++) out[i] = 0.01 * noise()
  const truth: number[] = []
  for (let k = 0, t = offset; t < seconds - 0.2; k++, t = offset + k * 60 / bpm) {
    truth.push(t)
    const gain = k % 4 === 0 ? 0.9 : 0.4, start = Math.round(t * RATE)
    for (let j = 0; j < 0.15 * RATE && start + j < out.length; j++) {
      const s = j / RATE
      out[start + j] += gain * (Math.sin(2 * Math.PI * 60 * s) * Math.exp(-s * 25) + (j < 0.004 * RATE ? 0.5 * noise() : 0))
    }
  }
  return { mono: out, truth }
}

const nearest = (t: number, xs: number[]) => Math.min(...xs.map(x => Math.abs(x - t)))

test('120 BPM with accented bar starts: tempo, beat times and downbeats', () => {
  const { mono, truth } = track(120, 20, 0.3)
  const grid = detectBeats(mono, RATE)
  expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(1)
  expect(grid.confidence).toBeGreaterThan(0)
  const inner = grid.beats.filter(t => t > 1 && t < 19)
  expect(inner.length).toBeGreaterThan(30)
  expect(inner.filter(t => nearest(t, truth) <= 0.02).length / inner.length).toBeGreaterThan(0.9)
  const accented = truth.filter((_, k) => k % 4 === 0)
  expect(grid.downbeats.length).toBeGreaterThan(5)
  expect(grid.downbeats.filter(t => nearest(t, accented) <= 0.02).length / grid.downbeats.length).toBeGreaterThan(0.9)
  expect(grid.onsets.filter(t => nearest(t, truth) <= 0.02).length).toBeGreaterThan(30)
})

test('95 BPM', () => {
  const { mono, truth } = track(95, 24, 0.5)
  const grid = detectBeats(mono, RATE)
  expect(Math.abs(grid.bpm - 95)).toBeLessThanOrEqual(1)
  const inner = grid.beats.filter(t => t > 1 && t < 23)
  expect(inner.filter(t => nearest(t, truth) <= 0.02).length / inner.length).toBeGreaterThan(0.9)
})

test('silence and very short input give an empty grid', () => {
  expect(detectBeats(new Float32Array(RATE * 5), RATE)).toEqual({ bpm: 0, confidence: 0, beats: [], downbeats: [], onsets: [] })
  expect(detectBeats(new Float32Array(100), RATE).bpm).toBe(0)
})

test('toMono averages interleaved channels', () => {
  expect([...toMono(new Float32Array([1, 0, 0.5, 0.5]))]).toEqual([0.5, 0.5])
})

test('ten minutes at 22.05 kHz stays fast', () => {
  const { mono } = track(128, 600, 0.1)
  const t0 = performance.now()
  const grid = detectBeats(mono, RATE)
  expect(performance.now() - t0).toBeLessThan(5000)
  expect(Math.abs(grid.bpm - 128)).toBeLessThanOrEqual(1)
})
