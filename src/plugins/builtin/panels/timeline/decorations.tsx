import { createMemo, For, onCleanup, onMount } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { Clip, TimelineDecorationContext, TimelineDecorationContribution, TimelineDecorationTarget, Track } from '@core/plugin-api'
import { useRegistry } from '@ui/reactive'

type Geometry = Omit<TimelineDecorationContext, 'app' | 'target'>

/**
 * Hosts the `timelineDecorations` contributions of one target (ruler, a track lane or a clip).
 * The timeline supplies the geometry for the area; plugins draw into the mount element.
 */
export function Decorations(props: { app: CascadeAPI; target: TimelineDecorationTarget; geometry: Geometry; subject?: () => { track?: Track; clip?: Clip } }) {
  const all = useRegistry(props.app.registries.timelineDecorations)
  const active = createMemo(() =>
    all()
      .filter((d) => d.target === props.target && (!d.when || d.when(props.app, props.subject?.() ?? {})))
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  )
  return <For each={active()}>{(d) => <DecorationMount deco={d} ctx={{ app: props.app, target: props.target, ...props.geometry }} />}</For>
}

function DecorationMount(props: { deco: TimelineDecorationContribution; ctx: TimelineDecorationContext }) {
  let el!: HTMLDivElement
  onMount(() => {
    let cleanup: void | (() => void)
    try {
      cleanup = props.deco.mount(el, props.ctx)
    } catch (e) {
      console.error(`[timeline] decoration ${props.deco.id} failed`, e)
    }
    onCleanup(() => cleanup?.())
  })
  return <div ref={el} class="tl-deco" data-deco={props.deco.id} />
}
