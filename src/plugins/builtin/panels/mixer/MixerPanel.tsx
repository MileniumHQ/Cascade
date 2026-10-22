import { createMemo, For, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { PanelContext } from '@core/plugin-api'
import { MASTER_CHANNEL, MIN_DB, clamp, dbToFader, faderToDb, trackChannel, trackGainDb, trackPan } from '@shared/audio-mix'
import type { Id, Track } from '@shared/project'
import { Icon } from '@ui/icon'
import { Empty } from '@ui/kit'
import { useProject } from '@ui/reactive'
import { MeterBar } from './MeterBar'
import './mixer.css'

const fmtDb = (db: number) => (db <= MIN_DB ? '-inf' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`)
const fmtPan = (p: number) => (Math.abs(p) < 0.005 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`)

/** Pointer-drag a 0..1 position along an element; calls `phase` start/update/end. */
function drag(e: PointerEvent, el: HTMLElement, vertical: boolean, onPos: (p: number, phase: 'start' | 'update' | 'end') => void) {
  if (e.button !== 0) return
  e.preventDefault()
  const at = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect()
    return clamp(vertical ? 1 - (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width, 0, 1)
  }
  onPos(at(e), 'start')
  const move = (ev: PointerEvent) => onPos(at(ev), 'update')
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onPos(at(ev), 'end')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Stand-in for the instant between a track's removal and its strip unmounting. */
const GONE: Track = { id: '', kind: 'audio', name: '', hidden: false, muted: false, locked: false, clips: [] }
const SCALE = [12, 6, 0, -6, -12, -24, -40, -60]

function Strip(props: { app: CascadeAPI; trackId: Id; visible: () => boolean; track: () => Track | undefined }) {
  const app = props.app
  const t = () => props.track() ?? GONE
  const gain = () => trackGainDb(t())
  const pan = () => trackPan(t())
  let faderEl!: HTMLDivElement
  let panEl!: HTMLDivElement
  const setGain = (db: number, phase: 'start' | 'update' | 'end') =>
    app.edit.updateTrack(props.trackId, { gain: Math.abs(db) < 0.25 ? 0 : Math.round(db * 10) / 10 }, { gesture: phase })
  const setPan = (p: number, phase: 'start' | 'update' | 'end') =>
    app.edit.updateTrack(props.trackId, { pan: Math.abs(p) < 0.03 ? 0 : Math.round(p * 100) / 100 }, { gesture: phase })
  return (
    <div class="mx-strip" classList={{ muted: t().muted }}>
      <div class="mx-name" title={t().name}>{t().name}</div>
      <div
        class="mx-pan"
        ref={panEl}
        data-tip={`Pan ${fmtPan(pan())} — double-click to center`}
        onPointerDown={(e) => drag(e, panEl, false, (p, phase) => setPan(p * 2 - 1, phase))}
        onDblClick={() => app.edit.updateTrack(props.trackId, { pan: 0 })}
      >
        <div class="mx-pan-mid" />
        <div class="mx-pan-thumb" style={{ left: `${(pan() + 1) * 50}%` }} />
      </div>
      <div class="mx-pan-val">{fmtPan(pan())}</div>
      <div class="mx-body">
        <div class="mx-scale">
          <For each={SCALE}>{(db) => <span style={{ bottom: `${dbToFader(db) * 100}%` }}>{db}</span>}</For>
        </div>
        <div
          class="mx-fader"
          ref={faderEl}
          data-tip="Drag to set level — double-click for 0 dB"
          onPointerDown={(e) => drag(e, faderEl, true, (p, phase) => setGain(faderToDb(p), phase))}
          onDblClick={() => app.edit.updateTrack(props.trackId, { gain: 0 })}
        >
          <div class="mx-fader-zero" style={{ bottom: `${dbToFader(0) * 100}%` }} />
          <div class="mx-fader-thumb" style={{ bottom: `${dbToFader(gain()) * 100}%` }} />
        </div>
        <MeterBar app={app} channel={trackChannel(props.trackId)} visible={props.visible} />
      </div>
      <div class="mx-db tnum" onDblClick={() => app.edit.updateTrack(props.trackId, { gain: 0 })}>{fmtDb(gain())}</div>
      <div class="mx-btns">
        <button class={t().muted ? 'on warn' : ''} data-tip={t().muted ? 'Unmute' : 'Mute'} onClick={() => app.edit.updateTrack(props.trackId, { muted: !t().muted })}>
          <Icon name={t().muted ? 'volume-x' : 'volume-2'} size={13} />
        </button>
        <button class={`mx-solo${t().solo ? ' on' : ''}`} data-tip={t().solo ? 'Unsolo' : 'Solo'} onClick={() => app.edit.updateTrack(props.trackId, { solo: !t().solo })}>
          S
        </button>
      </div>
    </div>
  )
}

function MasterStrip(props: { app: CascadeAPI; visible: () => boolean }) {
  return (
    <div class="mx-strip master">
      <div class="mx-name">Master</div>
      <div class="mx-body">
        <div class="mx-scale">
          <For each={SCALE}>{(db) => <span style={{ bottom: `${dbToFader(db) * 100}%` }}>{db}</span>}</For>
        </div>
        <MeterBar app={props.app} channel={MASTER_CHANNEL} visible={props.visible} />
      </div>
    </div>
  )
}

/** One strip per audio track (fader, pan, mute, solo, meter) plus the master meter. */
export function MixerPanel(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const project = useProject(app)
  let shown = true
  onCleanup(props.ctx.onVisibility((v) => (shown = v)) ?? (() => {}))
  const audioTracks = createMemo(() => project().timelines[project().activeTimeline]?.tracks.filter((x) => x.kind === 'audio') ?? [])
  // Strips are keyed by track id: an edit replaces the track object, which must not remount a strip mid-drag.
  const ids = createMemo<Id[]>((prev) => {
    const next = audioTracks().map((x) => x.id)
    return prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
  }, [])
  const visible = () => shown
  return (
    <div class="mx">
      <Show when={ids().length} fallback={<Empty icon="sliders-vertical" title="No audio tracks" />}>
        <div class="mx-strips">
          <For each={ids()}>{(id) => <Strip app={app} trackId={id} visible={visible} track={() => audioTracks().find((x) => x.id === id)} />}</For>
        </div>
        <MasterStrip app={app} visible={visible} />
      </Show>
    </div>
  )
}
