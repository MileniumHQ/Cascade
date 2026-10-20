import { toDisposable, type Disposable } from './disposable'
import { Emitter } from './events'

export interface Contribution {
  id: string
  /** Lower comes first. Built-ins use 0–999, external plugins start at 1000. */
  priority?: number
}

export interface Registered<T> {
  value: T
  pluginId: string
  builtin: boolean
}

/**
 * A keyed registry of plugin contributions. Later registrations with the same id replace earlier
 * ones (that's how hot reload swaps implementations); disposing restores the previous one.
 */
export class Registry<T extends Contribution> {
  private stacks = new Map<string, Registered<T>[]>()
  private version = 0
  readonly onChange = new Emitter<void>()

  constructor(readonly kind: string) {}

  register(value: T, pluginId: string, builtin: boolean): Disposable {
    const entry: Registered<T> = { value, pluginId, builtin }
    const stack = this.stacks.get(value.id) ?? []
    stack.push(entry)
    this.stacks.set(value.id, stack)
    this.changed()
    return toDisposable(() => {
      const s = this.stacks.get(value.id)
      if (!s) return
      const i = s.indexOf(entry)
      if (i >= 0) s.splice(i, 1)
      if (s.length === 0) this.stacks.delete(value.id)
      this.changed()
    })
  }

  private changed() {
    this.version++
    this.onChange.emit()
  }

  get revision() {
    return this.version
  }

  get(id: string): T | undefined {
    const s = this.stacks.get(id)
    return s?.[s.length - 1]?.value
  }

  entry(id: string): Registered<T> | undefined {
    const s = this.stacks.get(id)
    return s?.[s.length - 1]
  }

  has(id: string) {
    return this.stacks.has(id)
  }

  /** All active contributions, built-ins first, then by priority, then id. */
  entries(): Registered<T>[] {
    const list = [...this.stacks.values()].map((s) => s[s.length - 1])
    return list.sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      const pa = a.value.priority ?? (a.builtin ? 500 : 1000)
      const pb = b.value.priority ?? (b.builtin ? 500 : 1000)
      return pa - pb || a.value.id.localeCompare(b.value.id)
    })
  }

  all(): T[] {
    return this.entries().map((e) => e.value)
  }
}
