import { For } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { MountHost } from '@ui/mount-host'
import { useRegistry } from '@ui/reactive'

/** Blocks other plugins add to the Sources panel (`sourceSections`), ordered, above the media list. */
export function SourceSections(props: { app: CascadeAPI }) {
  const sections = useRegistry(props.app.registries.sourceSections)
  const ordered = () => [...sections()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  return <For each={ordered()}>{(s) => <MountHost class="sc-contrib" mount={s.mount} ctx={{ app: props.app }} />}</For>
}
