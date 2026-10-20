import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { Flicks } from '@shared/time'
import type { Project } from '@shared/project'
import type { KeyframesUi } from './state'
import type { KfRef } from './model'

/** Everything the panel's parts share. */
export interface PanelState {
  app: CascadeAPI
  ui: KeyframesUi
  project: Accessor<Project>
  /** Playhead time — only follows the playback while the panel is visible. */
  time: Accessor<Flicks>
  visible: Accessor<boolean>
  openMenu(e: MouseEvent, refs: KfRef[]): void
}

export function useGatedTime(app: CascadeAPI, visible: Accessor<boolean>): Accessor<Flicks> {
  const [t, setT] = createSignal(app.playback.time.get())
  createEffect(() => {
    if (!visible()) return
    setT(app.playback.time.get())
    const d = app.playback.time.subscribe(setT)
    onCleanup(() => d.dispose())
  })
  return t
}
