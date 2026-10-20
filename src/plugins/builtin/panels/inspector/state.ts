import { createSignal } from 'solid-js'
import type { Id } from '@shared/project'

/** Collapsed property cards, remembered across clip switches. */
const [collapsed, setCollapsed] = createSignal<ReadonlySet<Id>>(new Set())

export const isCollapsed = (id: Id) => collapsed().has(id)
export const setCardCollapsed = (id: Id, value: boolean) =>
  setCollapsed((s) => {
    const next = new Set(s)
    if (value) next.add(id)
    else next.delete(id)
    return next
  })
