import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { InspectorSectionContext, InspectorSectionContribution } from '@core/plugin-api'
import type { Id } from '@shared/project'
import { MountHost } from '@ui/mount-host'
import { useRegistry } from '@ui/reactive'

/** Sections that inspect a selection kind of their own (not `clip`), in registry order. */
export function useSubjectSection(app: CascadeAPI) {
  const sections = useRegistry(app.registries.inspectorSections)
  const subjects = createMemo(() => sections().filter((s) => s.subject !== 'clip' && s.selection))
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const offs = subjects().map((s) => s.selection!(app).subscribe(() => setTick((n) => n + 1)))
    onCleanup(() => offs.forEach((o) => o.dispose()))
  })
  return createMemo(() => {
    tick()
    return subjects().find((s) => {
      const ids = s.selection!(app).get()
      return ids.length > 0 && (!s.when || s.when(app, ids))
    })
  })
}

function context(app: CascadeAPI, ids: () => Id[], extra?: (fn: () => void) => () => void): InspectorSectionContext {
  return {
    app,
    ids,
    subscribe(fn) {
      const doc = app.doc.onChange.on(fn)
      const other = extra?.(fn)
      return () => (doc.dispose(), other?.())
    }
  }
}

/** Mounts a section that inspects a selection of its own; remounts when the first selected id changes. */
export function SubjectSection(props: { app: CascadeAPI; section: InspectorSectionContribution }) {
  const app = props.app, sel = () => props.section.selection!(app)
  const [first, setFirst] = createSignal(sel().get()[0])
  const watch = sel().subscribe((ids) => setFirst(ids[0]))
  onCleanup(() => watch.dispose())
  return (
    <Show when={first()} keyed>
      {(_id: Id) => <MountHost class="ins-section" mount={(el, ctx) => props.section.mount(el, ctx)} ctx={context(app, () => sel().get(), (fn) => { const d = sel().subscribe(fn); return () => d.dispose() })} />}
    </Show>
  )
}

/** Sections appended below the focused clip's own cards. */
export function ClipSections(props: { app: CascadeAPI; clipId: Id }) {
  const sections = useRegistry(props.app.registries.inspectorSections)
  const mine = createMemo(() => sections().filter((s) => s.subject === 'clip' && (!s.when || s.when(props.app, [props.clipId]))))
  return <>{mine().map((s) => <MountHost class="ins-section" mount={(el, ctx) => s.mount(el, ctx)} ctx={context(props.app, () => [props.clipId], (fn) => { const d = props.app.selection.clips.subscribe(fn); return () => d.dispose() })} />)}</>
}
