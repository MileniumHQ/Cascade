import { createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { MenuLayer, ToastLayer, TooltipLayer } from '../ui/kit'
import type { Session } from './session'
import { TitleBar } from './TitleBar'
import { Home } from './Home'
import { Workbench } from './Workbench'
import { matchKeybinding } from './keys'
import './app.css'

export function App(props: { app: CascadeApp; session: Session }) {
  const { app, session } = props
  // Track which panel the pointer/focus is in, for panel-scoped keybindings.
  const [activePanel, setActivePanel] = createSignal<string | null>(null)
  app.services.set('activePanel', activePanel)

  onMount(() => {
    const over = (e: PointerEvent) => {
      const p = (e.target as HTMLElement).closest?.('[data-panel]') as HTMLElement | null
      if (p) setActivePanel(p.dataset.panel!)
    }
    const key = (e: KeyboardEvent) => {
      if (session.screen() !== 'editor') return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable="true"], select')) return
      const kb = matchKeybinding(app, e, activePanel())
      if (kb) {
        e.preventDefault()
        e.stopPropagation()
        app.run(kb.command, ...(kb.args ?? []))
      }
    }
    window.addEventListener('pointerover', over, true)
    window.addEventListener('keydown', key)
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    onCleanup(() => {
      window.removeEventListener('pointerover', over, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    })
  })

  return (
    <div class="app">
      <TitleBar app={app} session={session} />
      <Switch>
        <Match when={session.screen() === 'home'}>
          <Home app={app} session={session} />
        </Match>
        <Match when={session.screen() === 'editor'}>
          <Workbench app={app} />
        </Match>
      </Switch>
      <Show when={true}>
        <MenuLayer />
        <TooltipLayer />
        <ToastLayer />
      </Show>
    </div>
  )
}
