import { onCleanup } from 'solid-js'
import type { Mount } from '@core/plugin-api'

/** Hosts a framework-agnostic `mount(el, ctx) => cleanup` contribution inside a Solid tree. */
export function MountHost<C>(props: { mount: Mount<C>; ctx: C; class?: string }) {
  let cleanup: (() => void) | void
  onCleanup(() => cleanup?.())
  return (
    <div
      class={props.class}
      ref={(el) => {
        cleanup = props.mount(el, props.ctx)
      }}
    />
  )
}
