import { createSignal, onCleanup, type Accessor, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import type { Cleanup, Mount } from '@core/plugin-api'

/** Adapt a Solid component to the framework-agnostic `mount(el, ctx) => cleanup` contract. */
export const solidMount =
  <C,>(Comp: (props: { ctx: C }) => JSX.Element): Mount<C> =>
  (el, ctx) =>
    render(() => <Comp ctx={ctx} />, el)

/** Accessor that re-reads whenever a `subscribe(fn) => cleanup` source fires. */
export function useSub<T>(subscribe: (fn: () => void) => Cleanup, read: () => T): Accessor<T> {
  const [get, set] = createSignal<T>(read(), { equals: false })
  onCleanup(subscribe(() => set(() => read())))
  return get
}
