import type { MeterReading } from '@shared/audio-mix'

/**
 * Level taps. Whatever runs the audio graph (the preview stage today; any plugin tomorrow)
 * registers a provider; meter UIs (mixer strips, status bar, user plugins) read channels from it.
 * Channels are opaque ids: `master`, `track:<trackId>` (see shared/audio-mix), or anything a plugin invents.
 */
export interface MeterProvider {
  /** Latest per-channel peak/RMS for a channel, or null when it has no signal source. Cheap enough to call once per animation frame. */
  read(channel: string): MeterReading | null
}

export class MeterService {
  private providers = new Set<MeterProvider>()

  /** Register a provider; the returned function removes it. */
  provide(provider: MeterProvider): () => void {
    this.providers.add(provider)
    return () => this.providers.delete(provider)
  }

  read(channel: string): MeterReading | null {
    for (const p of this.providers) {
      const r = p.read(channel)
      if (r) return r
    }
    return null
  }
}
