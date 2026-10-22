import { clamp } from '@shared/audio-mix'

/** Pointer-drag a 0..1 position along an element; calls `phase` start/update/end. */
export function drag(e: PointerEvent, el: HTMLElement, vertical: boolean, onPos: (p: number, phase: 'start' | 'update' | 'end') => void) {
  if (e.button !== 0) return
  e.preventDefault()
  const at = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect()
    return clamp(vertical ? 1 - (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width, 0, 1)
  }
  let last = at(e), ended = false
  onPos(last, 'start')
  const move = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) onPos(last = at(ev), 'update') }
  const stop = () => {
    if (ended) return
    ended = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    onPos(last, 'end')
  }
  const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) { last = at(ev); stop() } }
  const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) stop() }
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  return stop
}

