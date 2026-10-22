import { createMemo, For, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { findTransition, nearestTransitionEdge, transitionWindow } from '@core/transitions'
import { clipEnd, type Clip, type Id, type Track, type TransitionInstance } from '@shared/project'
import { FLICKS, frameDuration, snapToFrame, type Flicks } from '@shared/time'
import { useRegistry, useValue } from '@ui/reactive'
import { openContextMenu, type MenuItem } from '@ui/kit'
import './transitions.css'

/** Registry-driven submenu used both on cuts and the clip context menu. */
export function transitionMenu(app: CascadeAPI, track: Track, time: Flicks): MenuItem | null {
  const edge = nearestTransitionEdge(track, time)
  if (!edge) return null
  const types = app.registries.transitions.all().filter(t => t.kinds.includes(track.kind) && (edge.from && edge.to || t.singleSided !== false))
  return { label: 'Add transition', icon: 'layers', disabled: track.locked || !types.length, children: types.map(t => ({ label: t.name, icon: t.icon, run: () => {
    const id = app.edit.addTransition({ type: t.id, from: edge.from, to: edge.to })
    if (id) app.selection.setTransitions([id])
  } })) }
}

export function Transitions(props: { app: CascadeAPI; track: Track; x: (t: Flicks) => number; width: number; h: number }) {
  const app = props.app, selected = useValue(app.selection.transitions), types = useRegistry(app.registries.transitions)
  let cleanup: (() => void) | undefined
  onCleanup(() => cleanup?.())
  const select = (id: Id) => { app.selection.setTransitions([id]); app.selection.track.set(props.track.id) }
  const drag = (e: PointerEvent, id: Id, durationAt: (delta: Flicks) => Flicks) => {
    if ((e.button !== 0 && !(e.buttons & 1)) || props.track.locked) return
    e.preventDefault(); e.stopPropagation()
    cleanup?.()
    select(id)
    const x0 = e.clientX
    let duration = findTransition(app.timeline(), id)?.transition.duration ?? frameDuration(app.fps())
    const move = (ev: PointerEvent) => {
      duration = snapToFrame(Math.max(frameDuration(app.fps()), durationAt(app.view.pxToTime(ev.clientX - x0))), app.fps())
      app.edit.updateTransition(id, { duration }, { gesture: 'update' })
    }
    const up = () => { app.edit.updateTransition(id, { duration }, { gesture: 'end' }); stop() }
    const cancel = () => { app.doc.endGesture(); stop() }
    const stop = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      cleanup = undefined
    }
    app.doc.beginGesture(`transition:${id}`)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
    cleanup = cancel
  }
  const resize = (e: PointerEvent, tx: TransitionInstance, side: 'left' | 'right') => {
    const factor = tx.from && tx.to && tx.align === 'center' ? 2 : 1
    drag(e, tx.id, delta => tx.duration + delta * factor * (side === 'left' ? -1 : 1))
  }
  const fade = (e: PointerEvent, clip: Clip, edge: 'start' | 'end') => {
    if (e.button !== 0 || props.track.locked) return
    e.preventDefault(); e.stopPropagation()
    const existing = props.track.transitions?.find(t => edge === 'start' ? t.to === clip.id && !t.from : t.from === clip.id && !t.to)
    if (existing) return drag(e, existing.id, delta => existing.duration + delta * (edge === 'start' ? 1 : -1))
    const def = (types().find(t => t.id === (props.track.kind === 'visual' ? 'fade' : 'audio-crossfade')) ?? types().find(t => t.kinds.includes(props.track.kind) && t.singleSided !== false))
    if (!def) return
    const x0 = e.clientX
    const move = (ev: PointerEvent) => {
      const delta = app.view.pxToTime((ev.clientX - x0) * (edge === 'start' ? 1 : -1))
      if (delta < frameDuration(app.fps())) return
      stop()
      const id = app.edit.addTransition({ type: def.id, from: edge === 'end' ? clip.id : undefined, to: edge === 'start' ? clip.id : undefined, duration: snapToFrame(delta, app.fps()) }, { gesture: 'start' })
      if (id) drag(ev, id, d => delta + d * (edge === 'start' ? 1 : -1))
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); cleanup = undefined }
    cleanup?.(); cleanup = stop
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
  }
  const visible = createMemo(() => (props.track.transitions ?? []).filter(tx => { const w = transitionWindow(props.track, tx); return w && props.x(w.end) >= 0 && props.x(w.start) <= props.width }))
  return <div class="tl-transitions" style={{ height: `${props.h}px` }}>
    <For each={visible()}>{tx => {
      const w = () => transitionWindow(props.track, tx)!
      return <div class="tl-transition" classList={{ selected: selected().includes(tx.id) }} style={{ left: `${props.x(w().start)}px`, width: `${Math.max(4, props.x(w().end) - props.x(w().start))}px` }}
        title={`${app.registries.transitions.get(tx.type)?.name ?? tx.type} · ${(tx.duration / FLICKS).toFixed(2)} s`}
        onPointerDown={e => { e.stopPropagation(); if (e.button === 0) select(tx.id) }}
        onContextMenu={e => {
          e.stopPropagation(); select(tx.id)
          const add = transitionMenu(app, props.track, w().to?.start ?? w().end)
          openContextMenu(e, [...(add ? [add, { separator: true }] : []), { label: 'Delete transition', icon: 'trash-2', disabled: props.track.locked, run: () => app.edit.removeTransitions([tx.id]) }])
        }}>
        <Show when={tx.from && (!tx.to || tx.align !== 'start')}><button class="tl-transition-edge left" aria-label="Resize transition start" onPointerDown={e => resize(e, tx, 'left')} /></Show>
        <span>{app.registries.transitions.get(tx.type)?.name ?? tx.type}</span>
        <Show when={tx.to && (!tx.from || tx.align !== 'end')}><button class="tl-transition-edge right" aria-label="Resize transition end" onPointerDown={e => resize(e, tx, 'right')} /></Show>
      </div>
    }}</For>
    <For each={props.track.clips.filter(c => props.x(clipEnd(c)) >= 0 && props.x(c.start) <= props.width)}>{clip => <>
      <For each={['start', 'end'] as const}>{edge => {
        const tx = () => props.track.transitions?.find(t => edge === 'start' ? t.to === clip.id && !t.from : t.from === clip.id && !t.to)
        const time = () => edge === 'start' ? clip.start + (tx()?.duration ?? 0) : clipEnd(clip) - (tx()?.duration ?? 0)
        return <button class={`tl-fade-handle ${edge}`} style={{ left: `${props.x(time()) - (edge === 'start' ? 0 : 9)}px` }} aria-label={`Drag to fade ${edge === 'start' ? 'in' : 'out'}`} title={`Fade ${edge === 'start' ? 'in' : 'out'}`} onPointerDown={e => fade(e, clip, edge)} />
      }}</For>
    </>}</For>
  </div>
}
