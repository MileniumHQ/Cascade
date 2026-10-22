/**
 * Beat grid for music: onset envelope from three band energies, tempo by envelope autocorrelation
 * (with a mild prior around 120 BPM against octave errors), beats by dynamic programming (Ellis 2007),
 * downbeats by the strongest beat phase mod 4. Pure DSP; times in seconds from the start of the PCM.
 */

export interface BeatGrid { bpm: number; confidence: number; beats: number[]; downbeats: number[]; onsets: number[] }

const EMPTY: BeatGrid = { bpm: 0, confidence: 0, beats: [], downbeats: [], onsets: [] }

export function toMono(interleaved: Float32Array, channels = 2): Float32Array {
  if (channels === 1) return interleaved
  const n = Math.floor(interleaved.length / channels), out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c]
    out[i] = sum / channels
  }
  return out
}

/** Per-hop energy of low (<150 Hz), mid and high (>2 kHz) bands, split with one-pole filters. */
function bandEnergies(x: Float32Array, rate: number, hop: number) {
  const frames = Math.floor(x.length / hop)
  const bands = [new Float64Array(frames), new Float64Array(frames), new Float64Array(frames)]
  const a1 = Math.exp(-2 * Math.PI * 150 / rate), a2 = Math.exp(-2 * Math.PI * 2000 / rate)
  let lp1 = 0, lp2 = 0
  for (let f = 0; f < frames; f++) {
    let e0 = 0, e1 = 0, e2 = 0
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const v = x[i]
      lp1 = (1 - a1) * v + a1 * lp1
      lp2 = (1 - a2) * v + a2 * lp2
      const mid = lp2 - lp1, high = v - lp2
      e0 += lp1 * lp1; e1 += mid * mid; e2 += high * high
    }
    bands[0][f] = e0; bands[1][f] = e1; bands[2][f] = e2
  }
  return bands
}

/** Moving mean over ±w frames (prefix sums). */
function movingMean(x: Float64Array, w: number) {
  const prefix = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i]
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - w), b = Math.min(x.length, i + w + 1)
    out[i] = (prefix[b] - prefix[a]) / (b - a)
  }
  return out
}

/** Sub-frame peak offset (−0.5…0.5) from the parabola through three samples. */
const parabola = (a: number, b: number, c: number) => {
  const d = a - 2 * b + c
  return d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0
}

export function detectBeats(mono: Float32Array, rate: number, opts: { minBpm?: number; maxBpm?: number } = {}): BeatGrid {
  const minBpm = opts.minBpm ?? 70, maxBpm = opts.maxBpm ?? 180
  const hop = Math.max(1, Math.round(rate * 0.0116)), fps = rate / hop
  const bands = bandEnergies(mono, rate, hop)
  const n = bands[0].length
  const maxLag = Math.ceil(fps * 60 / minBpm), minLag = Math.floor(fps * 60 / maxBpm)
  if (n < 2 * maxLag + 2) return EMPTY
  // Log-compressed positive band differences: a 60 dB range below each band's loudest hop.
  const env = new Float64Array(n), low = new Float64Array(n)
  let peakEnergy = 0
  for (const band of bands) {
    let max = 0
    for (let i = 0; i < n; i++) if (band[i] > max) max = band[i]
    peakEnergy = Math.max(peakEnergy, max)
    if (max <= 0) continue
    const ref = max * 1e-6
    let prev = Math.log1p(band[0] / ref)
    for (let i = 1; i < n; i++) {
      const cur = Math.log1p(band[i] / ref), d = Math.max(0, cur - prev)
      env[i] += d
      if (band === bands[0]) low[i] = d
      prev = cur
    }
  }
  if (peakEnergy < 1e-10 * hop) return EMPTY
  // Keep only what rises above the local level, so sustained parts don't read as a dense pulse.
  const local = movingMean(env, Math.round(fps * 0.25))
  for (let i = 0; i < n; i++) env[i] = Math.max(0, env[i] - local[i])
  let mean = 0, sq = 0, envMax = 0
  for (let i = 0; i < n; i++) { mean += env[i]; if (env[i] > envMax) envMax = env[i] }
  mean /= n
  for (let i = 0; i < n; i++) sq += (env[i] - mean) ** 2
  const std = Math.sqrt(sq / n)
  if (!(std > 1e-9)) return EMPTY

  const onsets: number[] = []
  const w = Math.max(1, Math.round(fps * 0.045)), around = movingMean(env, Math.round(fps * 0.2))
  for (let i = 1; i < n - 1; i++) {
    if (env[i] < around[i] * 1.5 + 0.08 * envMax) continue
    let peak = true
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w) && peak; j++) if (env[j] > env[i] || (env[j] === env[i] && j < i)) peak = false
    if (peak) onsets.push(+((i + 0.5 + parabola(env[i - 1], env[i], env[i + 1])) / fps).toFixed(4))
  }

  // Tempo: autocorrelation of the centered envelope, summed over the first four multiples of each candidate period.
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) z[i] = (env[i] - mean) / std
  const top = Math.min(n - 1, 4 * maxLag + 2), ac = new Float64Array(top + 1)
  for (let lag = 0; lag <= top; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += z[i] * z[i - lag]
    ac[lag] = s / (n - lag)
  }
  const at = (t: number) => { const i = Math.floor(t), f = t - i; return i + 1 > top ? 0 : ac[i] * (1 - f) + ac[i + 1] * f }
  let period = 0, best = -Infinity
  for (let tau = minLag; tau <= maxLag; tau += 0.05) {
    let s = 0
    for (let k = 1; k <= 4; k++) s += at(k * tau)
    const bpm = 60 * fps / tau, prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2)
    if (s * prior > best) { best = s * prior; period = tau }
  }
  if (!(period > 0) || best <= 0) return { ...EMPTY, onsets }
  const confidence = Math.max(0, Math.min(1, at(period) / ac[0]))

  // Dynamic programming: each beat rewards onset strength, penalizes intervals off the period.
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t++) {
    let bestPrev = -Infinity, link = -1
    for (let p = Math.max(0, Math.floor(t - 2 * period)); p <= t - Math.round(period / 2); p++) {
      const v = score[p] - 100 * Math.log((t - p) / period) ** 2
      if (v > bestPrev) { bestPrev = v; link = p }
    }
    score[t] = z[t] + (link >= 0 ? bestPrev : 0)
    back[t] = link
  }
  let last = n - 1
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) if (score[t] > score[last]) last = t
  const frames: number[] = []
  for (let t = last; t >= 0; t = back[t]) frames.unshift(t)
  // Snap to the strongest onset within ±40 ms, then drop weak beats at either end (leading/trailing silence).
  const reach = Math.max(1, Math.round(fps * 0.04))
  const snapped = frames.map(f => {
    let m = f
    for (let j = Math.max(1, f - reach); j <= Math.min(n - 2, f + reach); j++) if (env[j] > env[m]) m = j
    return m
  })
  const strength = snapped.map(f => env[f])
  const median = [...strength].sort((a, b) => a - b)[Math.floor(strength.length / 2)] ?? 0
  let from = 0, to = snapped.length
  while (from < to && strength[from] < 0.25 * median) from++
  while (to > from && strength[to - 1] < 0.25 * median) to--
  const kept = snapped.slice(from, to)
  const beats = kept.map(f => +((f + 0.5 + (f > 0 && f < n - 1 ? parabola(env[f - 1], env[f], env[f + 1]) : 0)) / fps).toFixed(4))
  if (beats.length < 2) return { bpm: +(60 * fps / period).toFixed(2), confidence, beats, downbeats: [], onsets }

  // Tempo from the tracked beats (least squares over beat index) is finer than the lag grid.
  const k = beats.length, mk = (k - 1) / 2, mt = beats.reduce((a, b) => a + b, 0) / k
  let num = 0, den = 0
  beats.forEach((t, i) => { num += (i - mk) * (t - mt); den += (i - mk) ** 2 })
  const bpm = +(60 / (num / den)).toFixed(2)

  const accent = [0, 0, 0, 0]
  kept.forEach((f, i) => { accent[i % 4] += env[f] + 2 * low[f] })
  const phase = accent.indexOf(Math.max(...accent))
  const downbeats = beats.filter((_, i) => i % 4 === phase)
  return { bpm, confidence: +confidence.toFixed(3), beats, downbeats, onsets }
}
