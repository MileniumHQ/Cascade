import { For, onCleanup, onMount } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { Id, SourceItemDecorationContribution } from '@core/plugin-api'
import { useRegistry } from '@ui/reactive'

/** Hosts `sourceItemDecorations` over a media item's thumbnail. */
export function ItemDecorations(props: { api: { app: CascadeAPI }; id: Id }) {
  const decorations = useRegistry(props.api.app.registries.sourceItemDecorations)
  return <For each={decorations()}>{(d) => <Decoration app={props.api.app} id={props.id} deco={d} />}</For>
}

function Decoration(props: { app: CascadeAPI; id: Id; deco: SourceItemDecorationContribution }) {
  let el!: HTMLSpanElement
  onMount(() => {
    const app = props.app, id = props.id
    let cleanup: void | (() => void)
    try {
      cleanup = props.deco.mount(el, {
        app, mediaId: id, media: () => app.project().media[id],
        subscribe: (fn) => { const d = app.doc.onChange.on(fn); return () => d.dispose() }
      })
    } catch (e) {
      console.error(`[sources] item decoration ${props.deco.id} failed`, e)
    }
    onCleanup(() => cleanup?.())
  })
  return <span ref={el} class="sc-item-deco" />
}
