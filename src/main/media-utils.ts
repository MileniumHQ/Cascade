/** At most 600 grid samples; short footage benefits from half-second previews. */
export function thumbnailInterval(duration: number): number {
  if (duration <= 30) return 0.5
  const minimum = Math.max(1, duration / 600)
  for (const step of [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600]) {
    if (step >= minimum) return step
  }
  return Math.ceil(minimum / 3600) * 3600
}

/** Incremental 8 kHz float PCM → 200 min/max pairs per second, including a final partial pair. */
export class PeakBuilder {
  private carry = Buffer.alloc(0)
  private samples = 0
  private min = Infinity
  private max = -Infinity
  length = 0

  push(chunk: Buffer): Buffer {
    const bytes = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const sampleCount = Math.floor(bytes.length / 4)
    const result = Buffer.allocUnsafe(Math.floor((sampleCount + this.samples) / 40) * 8)
    let offset = 0
    for (let i = 0; i < sampleCount; i++) {
      const raw = bytes.readFloatLE(i * 4)
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
      this.min = Math.min(this.min, value)
      this.max = Math.max(this.max, value)
      if (++this.samples === 40) {
        result.writeFloatLE(this.min, offset)
        result.writeFloatLE(this.max, offset + 4)
        offset += 8
        this.length++
        this.samples = 0
        this.min = Infinity
        this.max = -Infinity
      }
    }
    this.carry = Buffer.from(bytes.subarray(sampleCount * 4))
    return result
  }

  finish(): Buffer {
    if (!this.samples) return Buffer.alloc(0)
    const result = Buffer.allocUnsafe(8)
    result.writeFloatLE(this.min, 0)
    result.writeFloatLE(this.max, 4)
    this.length++
    this.samples = 0
    this.min = Infinity
    this.max = -Infinity
    return result
  }
}
