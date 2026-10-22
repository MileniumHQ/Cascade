/**
 * Loudness and peak measurement of rendered audio (ITU-R BS.1770 / EBU R128): K-weighted,
 * 400 ms blocks with 75 % overlap, integrated loudness gated at -70 LUFS and -10 LU.
 */

export interface LoudnessReading {
  /** Integrated (gated) loudness in LUFS; -Infinity for silence. */
  integrated: number
  /** Loudest 400 ms block in LUFS. */
  momentaryMax: number
  /** Sample peak in dBFS. */
  peak: number
  /** RMS level in dBFS (both channels). */
  rms: number
  /** Samples at or above full scale (|x| ≥ 0.999): audible clipping. */
  clipped: number
  /** Start times (s, relative to the measured range) of clipped stretches, at most 20. */
  clipTimes: number[]
}

type Biquad = { b: [number, number, number]; a: [number, number] }

/** BS.1770 K-weighting (high shelf + high pass) for any sample rate. */
function kWeighting(rate: number): Biquad[] {
  let K = Math.tan((Math.PI * 1681.974450955533) / rate)
  let Q = 0.7071752369554196
  const Vh = Math.pow(10, 3.999843853973347 / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] }
  K = Math.tan((Math.PI * 38.13547087602444) / rate)
  Q = 0.5003270373238773
  a0 = 1 + K / Q + K * K
  const highpass: Biquad = { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] }
  return [shelf, highpass]
}

function filter(x: Float32Array, stages: Biquad[]): Float32Array {
  let input = x
  for (const { b, a } of stages) {
    const out = new Float32Array(input.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < input.length; i++) {
      const v = input[i]
      const y = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
      x2 = x1; x1 = v; y2 = y1; y1 = y
      out[i] = y
    }
    input = out
  }
  return input
}

const lufs = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity)

/** K-weighted channel signals of interleaved stereo PCM, computed once and measured per range. */
export class LoudnessMeter {
  private weighted: Float32Array[]
  private channels: Float32Array[]
  constructor(interleaved: Float32Array, readonly rate: number) {
    const frames = Math.floor(interleaved.length / 2)
    this.channels = [0, 1].map((c) => {
      const ch = new Float32Array(frames)
      for (let i = 0; i < frames; i++) ch[i] = interleaved[i * 2 + c]
      return ch
    })
    const k = kWeighting(rate)
    this.weighted = this.channels.map((ch) => filter(ch, k))
  }

  /** How the two channels relate: stereo, mono carried on both, one side only, or silence. */
  layout(): 'stereo' | 'mono (same on both channels)' | 'left only' | 'right only' | 'silent' {
    const [l, r] = this.channels
    let ll = 0, rr = 0, diff = 0
    for (let i = 0; i < l.length; i++) { ll += l[i] * l[i]; rr += r[i] * r[i]; diff += (l[i] - r[i]) ** 2 }
    if (ll + rr < 1e-9 * l.length) return 'silent'
    if (rr < ll * 1e-4) return 'left only'
    if (ll < rr * 1e-4) return 'right only'
    return diff < (ll + rr) * 1e-4 ? 'mono (same on both channels)' : 'stereo'
  }

  get duration() {
    return this.channels[0].length / this.rate
  }

  /** Reading for [from, to) seconds. */
  measure(from = 0, to = this.duration): LoudnessReading {
    const n = this.channels[0].length
    const i0 = Math.max(0, Math.floor(from * this.rate))
    const i1 = Math.min(n, Math.ceil(to * this.rate))
    let peak = 0
    let clipped = 0
    let square = 0
    const clipTimes: number[] = []
    let lastClip = -Infinity
    for (const ch of this.channels) {
      for (let i = i0; i < i1; i++) {
        const v = Math.abs(ch[i])
        square += v * v
        if (v > peak) peak = v
        if (v >= 0.999) {
          clipped++
          const t = (i - i0) / this.rate
          if (t - lastClip > 0.25 && clipTimes.length < 20) clipTimes.push(+t.toFixed(3))
          lastClip = t
        }
      }
    }
    clipTimes.sort((a, b) => a - b)
    // 400 ms blocks, 100 ms hop; a range shorter than a block is one block.
    const block = Math.round(0.4 * this.rate)
    const hop = Math.round(0.1 * this.rate)
    const powers: number[] = []
    for (let s = i0; s === i0 || s + block <= i1; s += hop) {
      const e = Math.min(i1, s + block)
      if (e <= s) break
      let sum = 0
      for (const w of this.weighted) for (let i = s; i < e; i++) sum += w[i] * w[i]
      powers.push(sum / (e - s))
    }
    const momentaryMax = Math.max(-Infinity, ...powers.map(lufs))
    const abs = powers.filter((p) => lufs(p) > -70)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    let integrated = -Infinity
    if (abs.length) {
      const gate = lufs(mean(abs)) - 10
      const rel = abs.filter((p) => lufs(p) > gate)
      if (rel.length) integrated = lufs(mean(rel))
    }
    const meanSquare = square / Math.max(1, (i1 - i0) * this.channels.length)
    return { integrated, momentaryMax, peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity, rms: meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity, clipped, clipTimes }
  }

  /** Mean K-weighted power of samples [s, e). */
  private power(s: number, e: number): number {
    let sum = 0
    for (const w of this.weighted) for (let i = s; i < e; i++) sum += w[i] * w[i]
    return e > s ? sum / (e - s) : 0
  }

  /** Loudness (LUFS) of the 400 ms window starting every `step` seconds: the shape of the mix over time. */
  envelope(step: number): number[] {
    const n = this.channels[0].length, block = Math.round(0.4 * this.rate), out: number[] = []
    for (let t = 0; t * this.rate < n; t += step) {
      const s = Math.floor(t * this.rate)
      out.push(lufs(this.power(s, Math.min(n, s + block))))
    }
    return out
  }

  /** Stretches of at least `min` seconds where the 400 ms loudness stays below `threshold` LUFS, as [start, end] seconds. */
  silences(threshold = -50, min = 0.5): [number, number][] {
    const n = this.channels[0].length, block = Math.round(0.4 * this.rate), hop = Math.round(0.1 * this.rate)
    const out: [number, number][] = []
    let from = -1
    for (let s = 0; s < n; s += hop) {
      const quiet = lufs(this.power(s, Math.min(n, s + block))) < threshold
      if (quiet && from < 0) from = s
      if ((!quiet || s + hop >= n) && from >= 0) {
        const end = quiet ? n : Math.min(n, s + block - hop)
        if ((end - from) / this.rate >= min) out.push([from / this.rate, end / this.rate])
        from = -1
      }
    }
    return out
  }
}

const BARS = '▁▂▃▄▅▆▇█'
/** One character per value: space below -60 LUFS (silence), then ▁ (-60) … █ (-12 and louder). */
export const sparkline = (values: number[]) => values.map(v => v < -60 ? ' ' : BARS[Math.min(BARS.length - 1, Math.max(0, Math.floor((v + 60) / 6)))]).join('')

export const formatDb = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-inf')
