import { createSignal, onCleanup, type Accessor } from 'solid-js'
import type { Value } from '@core/value'
import type { Emitter } from '@core/events'
import type { CascadeAPI } from '@core/app'
import type { Registry, Contribution } from '@core/registry'
import type { Project } from '@shared/project'

/** Subscribe a Solid accessor to a core Value. */
export function useValue<T>(v: Value<T>): Accessor<T> {
  const [get, set] = createSignal<T>(v.get(), { equals: false })
  const d = v.subscribe((x) => set(() => x))
  onCleanup(() => d.dispose())
  return get
}

/** Accessor that re-evaluates whenever an emitter fires. */
export function useEmitter<T>(e: Emitter<unknown>, read: () => T): Accessor<T> {
  const [get, set] = createSignal<T>(read(), { equals: false })
  const d = e.on(() => set(() => read()))
  onCleanup(() => d.dispose())
  return get
}

/** The project document as a Solid accessor (immutable snapshots, structural sharing). */
export function useProject(app: CascadeAPI): Accessor<Project> {
  return useEmitter(app.doc.onChange as Emitter<unknown>, () => app.doc.state)
}

/** Registry contents as an accessor (updates on plugin (un)registration / hot reload). */
export function useRegistry<T extends Contribution>(r: Registry<T>): Accessor<T[]> {
  return useEmitter(r.onChange as Emitter<unknown>, () => r.all())
}

/** Run `fn` whenever an emitter fires, for the lifetime of the owner. */
export function onEmit<T>(e: Emitter<T>, fn: (v: T) => void) {
  const d = e.on(fn)
  onCleanup(() => d.dispose())
}
