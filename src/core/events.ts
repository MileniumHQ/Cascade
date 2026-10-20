import { toDisposable, type Disposable } from './disposable'

export type Listener<T> = (value: T) => void

/** Minimal typed event emitter. */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>()
  on(fn: Listener<T>): Disposable {
    this.listeners.add(fn)
    return toDisposable(() => this.listeners.delete(fn))
  }
  emit(value: T) {
    for (const fn of [...this.listeners]) {
      try {
        fn(value)
      } catch (e) {
        console.error('[cascade] listener failed', e)
      }
    }
  }
  get size() {
    return this.listeners.size
  }
}

/** Named event bus for loose coupling between plugins: `bus.on('clip:selected', fn)`. */
export class EventBus {
  private emitters = new Map<string, Emitter<unknown>>()
  on<T = unknown>(name: string, fn: Listener<T>): Disposable {
    let e = this.emitters.get(name)
    if (!e) this.emitters.set(name, (e = new Emitter()))
    return e.on(fn as Listener<unknown>)
  }
  emit<T = unknown>(name: string, value?: T) {
    this.emitters.get(name)?.emit(value)
  }
}
