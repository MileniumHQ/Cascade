import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Emitter } from '@core/events'
import { SOURCE_RANGE_MIME } from '@core/three-point'
import type { ClipBodyContext, PanelContext } from '@core/plugin-api'
import { FLICKS, formatTimecode, snapToFrame } from '@shared/time'
import { Icon } from '@ui/icon'
import { IconButton } from '@ui/kit'
import { useEmitter, useProject, useValue } from '@ui/reactive'
import { PreviewEngine } from '../preview/engine'
import { setDragImage } from '../sources/Item'
import { markedRange } from './marks'
import type { SourceMonitor } from './service'
import './source.css'

export function SourceMonitorView(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const mon = app.services.get('source') as SourceMonitor
  const project = useProject(app)
  const mediaId = useValue(mon.mediaId)
  const time = useValue(mon.playback.time)
  const playing = useValue(mon.playback.playing)
  const marks = useValue(mon.marks)
  const lanes = useValue(mon.lanes)
  const item = useEmitter(mon.rebuilt as Emitter<unknown>, () => mon.item())
  const fps = () => project().settings.fps
  const duration = () => item()?.duration ?? 0

  let viewport!: HTMLDivElement
  let frameEl!: HTMLDivElement
  let stageHost!: HTMLDivElement
  let scrub!: HTMLDivElement
  let body!: HTMLDivElement
  const bodyChanges = new Emitter<void>()

  onMount(() => {
    const engine = new PreviewEngine(app, stageHost, mon.feed())
    const layout = () => {
      const s = project().settings
      const scale = Math.min((viewport.clientWidth - 24) / s.width, (viewport.clientHeight - 24) / s.height)
      const w = Math.max(1, Math.round(s.width * scale))
      const h = Math.max(1, Math.round(s.height * scale))
      frameEl.style.width = `${w}px`
      frameEl.style.height = `${h}px`
      engine.setDisplaySize(w, h)
    }
    const ro = new ResizeObserver(layout)
    ro.observe(viewport)
    const d = app.doc.onChange.on(layout)
    const bodyRo = new ResizeObserver(() => bodyChanges.emit())
    bodyRo.observe(scrub)
    const vis = props.ctx.onVisibility((v) => {
      if (v) engine.request()
      else mon.playback.pause()
    })
    onCleanup(() => {
      ro.disconnect()
      bodyRo.disconnect()
      d.dispose()
      vis()
      engine.dispose()
    })
  })

  // The media type's own timeline body (filmstrip, waveform…) behind the scrub bar.
  createEffect(() => {
    const it = item()
    if (!it?.mt.clipBody) return
    const ctx: ClipBodyContext = {
      app,
      clip: () => it.clip,
      media: () => it.media,
      view: () => ({
        pxPerSecond: scrub.clientWidth / Math.max(1e-6, it.duration / FLICKS),
        visibleStart: 0,
        visibleEnd: it.duration,
        height: Math.max(8, scrub.clientHeight)
      }),
      subscribe: (fn) => {
        const d = bodyChanges.on(fn)
        return () => d.dispose()
      }
    }
    body.style.setProperty('--c', it.mt.color)
    let cleanup: void | (() => void)
    try {
      cleanup = it.mt.clipBody(body, ctx)
    } catch (e) {
      console.warn('[source] clip body failed', e)
    }
    onCleanup(() => {
      try {
        cleanup?.()
      } catch {}
      body.replaceChildren()
    })
  })

  const pct = (t: number) => `${duration() ? Math.min(100, Math.max(0, (t / duration()) * 100)) : 0}%`
  const range = createMemo(() => {
    const m = marks()
    return m.in === undefined && m.out === undefined ? null : markedRange(m, duration())
  })
  const seekFrom = (e: PointerEvent) => {
    const r = scrub.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    mon.playback.pause()
    mon.playback.seek(snapToFrame(f * duration(), fps()))
  }
  const scrubDown = (e: PointerEvent) => {
    if (e.button !== 0 || !duration()) return
    scrub.setPointerCapture(e.pointerId)
    seekFrom(e)
    const move = (ev: PointerEvent) => seekFrom(ev)
    const up = () => {
      scrub.removeEventListener('pointermove', move)
      scrub.removeEventListener('pointerup', up)
    }
    scrub.addEventListener('pointermove', move)
    scrub.addEventListener('pointerup', up)
  }

  const dragStart = (e: DragEvent) => {
    const it = item()
    const dt = e.dataTransfer
    if (!it || !dt) return e.preventDefault()
    const m = marks()
    dt.setData('application/x-cascade-media', it.media.id)
    dt.setData(SOURCE_RANGE_MIME, JSON.stringify({ sourceIn: m.in, sourceOut: m.out, lanes: lanes() }))
    dt.setData('text/plain', it.media.name)
    dt.effectAllowed = 'copy'
    setDragImage(e, it.mt.icon, it.media.name, it.mt.color)
  }

  const tc = (t: number) => formatTimecode(t, fps())
  const marked = () => (range() ? range()!.end - range()!.start : null)

  return (
    <div class="sm">
      <div class="sm-title">
        <Show when={item()} fallback={<span class="sm-title-empty">No source open</span>}>
          <Icon name={item()!.mt.icon} size={13} />
          <span class="sm-title-name">{item()!.media.name}</span>
        </Show>
      </div>
      <div class="sm-viewport" ref={viewport}>
        <div class="sm-frame" ref={frameEl} draggable={!!item()} onDragStart={dragStart}>
          <div class="sm-stage" ref={stageHost} />
        </div>
        <Show when={!mediaId()}>
          <div class="sm-empty">Double-click a source to preview it here</div>
        </Show>
      </div>
      <div class="sm-scrub" ref={scrub} classList={{ disabled: !duration() }} onPointerDown={scrubDown}>
        <div class="sm-scrub-body" ref={body} />
        <Show when={range()}>
          <div class="sm-range" style={{ left: pct(range()!.start), width: `calc(${pct(range()!.end)} - ${pct(range()!.start)})` }} />
        </Show>
        <Show when={marks().in !== undefined}>
          <div class="sm-mark in" style={{ left: pct(marks().in!) }} />
        </Show>
        <Show when={marks().out !== undefined}>
          <div class="sm-mark out" style={{ left: pct(marks().out!) }} />
        </Show>
        <div class="sm-head" style={{ left: pct(time()) }} />
      </div>
      <div class="sm-bar">
        <div class="sm-left">
          <div class="pv-tc tnum" data-tip="Source time">
            <span class="pv-tc-now">{tc(time())}</span>
            <span class="pv-tc-dur">/ {tc(duration())}</span>
          </div>
          <Show when={marked() !== null}>
            <span class="sm-badge tnum" data-tip="Marked range">
              {tc(marked()!)}
            </span>
          </Show>
        </div>
        <div class="sm-transport">
          <IconButton icon="mark-in" size="sm" tip="Mark in" kbd="I" active={marks().in !== undefined} onClick={() => app.run('source.markIn')} />
          <IconButton icon="mark-out" size="sm" tip="Mark out" kbd="O" active={marks().out !== undefined} onClick={() => app.run('source.markOut')} />
          <IconButton icon="skip-back" size="sm" tip="Go to start" kbd="Home" onClick={() => app.run('source.start')} />
          <IconButton icon="step-back" size="sm" tip="Previous frame" kbd="ArrowLeft" onClick={() => app.run('source.stepBack')} />
          <button class={`pv-play ${playing() ? 'on' : ''}`} onClick={() => app.run('source.toggle')} data-tip={playing() ? 'Pause' : 'Play'} data-kbd="Space">
            <Icon name={playing() ? 'pause' : 'play'} size={16} />
          </button>
          <IconButton icon="step-forward" size="sm" tip="Next frame" kbd="ArrowRight" onClick={() => app.run('source.stepForward')} />
          <IconButton icon="skip-forward" size="sm" tip="Go to end" kbd="End" onClick={() => app.run('source.end')} />
          <IconButton icon="x" size="sm" tip="Clear in/out" kbd="Alt+X" disabled={marks().in === undefined && marks().out === undefined} onClick={() => app.run('source.clearMarks')} />
        </div>
        <div class="sm-right">
          <IconButton
            icon="video"
            size="sm"
            tip="Bring video"
            active={lanes().visual && !!item()?.lanes.visual}
            disabled={!item()?.lanes.visual}
            onClick={() => mon.lanes.set({ ...lanes(), visual: !lanes().visual })}
          />
          <IconButton
            icon="volume-2"
            size="sm"
            tip="Bring audio"
            active={lanes().audio && !!item()?.lanes.audio}
            disabled={!item()?.lanes.audio}
            onClick={() => mon.lanes.set({ ...lanes(), audio: !lanes().audio })}
          />
          <span class="sm-sep" />
          <IconButton icon="edit-insert" size="sm" tip="Insert at playhead" kbd="," onClick={() => app.run('edit.insert')} />
          <IconButton icon="edit-overwrite" size="sm" tip="Overwrite at playhead" kbd="." onClick={() => app.run('edit.overwrite')} />
          <IconButton icon="edit-append" size="sm" tip="Append to end" kbd="Shift+E" onClick={() => app.run('edit.appendToEnd')} />
        </div>
      </div>
    </div>
  )
}
