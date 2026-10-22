import type { CascadeAPI } from '@core/app'
import { METER_FLOOR_DB, createMeterState, resetClip, stepMeter, type MeterState } from '@shared/audio-mix'

/** What a meter view renders. */
export type MeterView = (state: MeterState) => void

const quiet = (s: MeterState) => [...s.peak, ...s.rms, ...s.hold].every((v) => v <= METER_FLOOR_DB + 0.5)

/**
 * Drive a meter for `channel` from the app's level taps, once per animation frame while audio
 * plays and until the ballistics have fallen back to silence. Returns controls; `stop` ends it.
 * Paused playback reads as silence, so a stale analyser buffer never shows.
 */
export function runMeter(app: CascadeAPI, channel: string, view: MeterView, isVisible: () => boolean = () => true) {
  let state = createMeterState()
  let raf = 0
  let last = 0
  const frame = (now: number) => {
    raf = 0
    const dt = last ? Math.min(100, now - last) : 16
    last = now
    const playing = app.playback.playing.get()
    state = stepMeter(state, playing && isVisible() ? app.meters.read(channel) : null, dt)
    view(state)
    if (playing || !quiet(state)) raf = requestAnimationFrame(frame)
    else last = 0
  }
  const wake = () => {
    if (!raf) raf = requestAnimationFrame(frame)
  }
  const sub = app.playback.playing.subscribe(wake)
  wake()
  return {
    wake,
    resetClip() {
      state = resetClip(state)
      view(state)
    },
    stop() {
      sub.dispose()
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
  }
}
