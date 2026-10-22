import { onCleanup, onMount } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { METER_FLOOR_DB, type MeterState } from '@shared/audio-mix'
import { runMeter } from './ticker'

const pos = (db: number) => Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))

/** Stereo peak + RMS meter with peak hold and a latching clip light (click the light to reset). */
export function MeterBar(props: { app: CascadeAPI; channel: string; orientation?: 'vertical' | 'horizontal'; visible?: () => boolean; clip?: boolean }) {
  let root!: HTMLDivElement
  onMount(() => {
    const bars = [...root.querySelectorAll<HTMLElement>('.mx-ch')].map((el) => ({
      rms: el.querySelector<HTMLElement>('.mx-rms')!,
      peak: el.querySelector<HTMLElement>('.mx-peak')!,
      hold: el.querySelector<HTMLElement>('.mx-hold')!
    }))
    const lights = [...root.querySelectorAll<HTMLElement>('.mx-clip')]
    const vertical = props.orientation !== 'horizontal'
    const meter = runMeter(
      props.app,
      props.channel,
      (s: MeterState) => {
        bars.forEach((b, c) => {
          const rms = pos(s.rms[c]), peak = pos(s.peak[c]), hold = pos(s.hold[c])
          b.rms.style.transform = vertical ? `scaleY(${rms})` : `scaleX(${rms})`
          b.peak.style.transform = vertical ? `scaleY(${peak})` : `scaleX(${peak})`
          if (vertical) b.hold.style.bottom = `${hold * 100}%`
          else b.hold.style.left = `${hold * 100}%`
          b.hold.style.opacity = hold > 0.01 ? '1' : '0'
        })
        lights.forEach((l, c) => l.classList.toggle('on', s.clip[c]))
      },
      props.visible
    )
    root.addEventListener('mixer-reset', () => meter.resetClip())
    onCleanup(() => meter.stop())
  })
  const reset = () => root.dispatchEvent(new Event('mixer-reset'))
  return (
    <div class={`mx-meter ${props.orientation === 'horizontal' ? 'h' : 'v'}`} ref={root}>
      {[0, 1].map(() => (
        <div class="mx-chwrap">
          {props.clip !== false && <button class="mx-clip" data-tip="Clipped — click to reset" onClick={reset} />}
          <div class="mx-ch">
            <div class="mx-peak" />
            <div class="mx-rms" />
            <div class="mx-hold" />
          </div>
        </div>
      ))}
    </div>
  )
}
