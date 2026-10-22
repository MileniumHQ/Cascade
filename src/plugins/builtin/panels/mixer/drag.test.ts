import { afterEach, expect, it, vi } from 'vitest'
import { drag } from './drag'
const event = (type: string, x = 30) => Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: 20 }) as PointerEvent
const el = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as HTMLElement
afterEach(() => vi.unstubAllGlobals())
it('ends a cancelled fader gesture at its last position and removes listeners', () => {
  const win = new EventTarget(); vi.stubGlobal('window', win)
  const positions: [number, string][] = []
  drag(event('pointerdown'), el, false, (p, phase) => positions.push([p, phase]))
  win.dispatchEvent(event('pointermove', 60)); win.dispatchEvent(event('pointercancel', 0)); win.dispatchEvent(event('pointermove', 90))
  expect(positions).toEqual([[0.3, 'start'], [0.6, 'update'], [0.6, 'end']])
})
it('returns idempotent cleanup for unmount, closing the gesture', () => {
  const win = new EventTarget(); vi.stubGlobal('window', win)
  const positions: [number, string][] = []
  const cleanup = drag(event('pointerdown'), el, true, (p, phase) => positions.push([p, phase])) as unknown as () => void
  expect(cleanup).toBeTypeOf('function')
  cleanup(); cleanup(); win.dispatchEvent(event('pointerup'))
  expect(positions).toEqual([[0.8, 'start'], [0.8, 'end']])
})
