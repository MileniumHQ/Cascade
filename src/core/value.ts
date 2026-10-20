import type { Disposable } from './disposable'
import { Emitter } from './events'

/** Tiny observable value used by core services (UI layers adapt it to their own reactivity). */
export class Value<T> {
  private _v: T
  readonly onChange = new Emitter<T>()
  constructor(initial: T, private equals: (a: T, b: T) => boolean = Object.is) {
    this._v = initial
  }
  get(): T {
    return this._v
  }
  set(v: T) {
    if (this.equals(this._v, v)) return
    this._v = v
    this.onChange.emit(v)
  }
  update(fn: (v: T) => T) {
    this.set(fn(this._v))
  }
  subscribe(fn: (v: T) => void): Disposable {
    return this.onChange.on(fn)
  }
}

export const shallowArrayEqual = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])
