import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { Button, MenuLayer, Modal, TextField, ToastLayer, TooltipLayer } from '../ui/kit'
import type { Session } from './session'
import { installNativeMenu } from './menu'
import { ProjectSettingsModal } from './ProjectSettings'
import { SettingsModal } from './Settings'
import { Home } from './Home'
import { Workbench } from './Workbench'
import { matchKeybinding } from './keys'
import './app.css'

export function App(props: { app: CascadeApp; session: Session }) {
  const { app, session } = props
  // Track which panel the pointer/focus is in, for panel-scoped keybindings.
  const [activePanel, setActivePanel] = createSignal<string | null>(null)
  app.services.set('activePanel', activePanel)
  const [modal, setModal] = createSignal<'project' | 'settings' | 'rename' | null>(null)

  // App-level commands (they need the session / modals); the native menu exposes them.
  const editor = () => session.screen() === 'editor'
  const appCommands = [
    { id: 'project.new', title: 'New project', category: 'Project', run: () => void session.close() },
    { id: 'project.close', title: 'Close project', category: 'Project', run: () => void session.close(), enabled: editor },
    { id: 'project.settings', title: 'Project settings…', category: 'Project', run: () => setModal('project'), enabled: editor },
    { id: 'project.rename', title: 'Rename project…', category: 'Project', run: () => setModal('rename'), enabled: editor },
    { id: 'app.settings', title: 'Settings…', category: 'App', run: () => setModal('settings') },
    { id: 'app.quit', title: 'Quit', category: 'App', run: () => app.host?.window.close() },
    { id: 'plugins.openFolder', title: 'Open plugins folder', category: 'App', run: () => app.host?.plugins.openFolder() }
  ]
  const appMenu: [string, string, string, number][] = [
    ['project.new', 'project', 'New Project', -30],
    ['project.open', 'project', 'Open Project…', -20],
    ['project.settings', 'settings', 'Project Settings…', 100],
    ['project.rename', 'settings', 'Rename Project…', 110],
    ['app.settings', 'settings', 'Settings…', 120],
    ['project.close', 'quit', 'Close Project', 200],
    ['app.quit', 'quit', 'Quit', 210]
  ]
  const disposers = [
    ...appCommands.map((c) => app.registries.commands.register(c, 'cascade.app', true)),
    ...appMenu.map(([command, group, label, order]) => app.registries.menus.register({ id: `menu:${command}`, location: 'app/file', group, command, label, order }, 'cascade.app', true)),
    app.registries.menus.register({ id: 'menu:plugins.openFolder', location: 'app/help', command: 'plugins.openFolder', label: 'Open Plugins Folder' }, 'cascade.app', true),
    app.registries.keybindings.register({ id: 'app.settings:Mod+,', command: 'app.settings', key: 'Mod+,' }, 'cascade.app', true),
    app.registries.keybindings.register({ id: 'app.quit:Mod+Q', command: 'app.quit', key: 'Mod+Q' }, 'cascade.app', true)
  ]
  onCleanup(() => disposers.forEach((d) => d.dispose()))
  installNativeMenu(app, session)

  // Window title: project name, unsaved marker.
  const title = () => app.host?.window.setTitle(editor() ? `${app.doc.dirty ? '• ' : ''}${app.project().name} — Cascade` : 'Cascade')
  createEffect(() => { session.screen(); title() })
  const historySub = app.doc.onHistory.on(title)
  const docSub = app.doc.onChange.on(title)
  onCleanup(() => { historySub.dispose(); docSub.dispose() })

  onMount(() => {
    const over = (e: PointerEvent) => {
      const p = (e.target as HTMLElement).closest?.('[data-panel]') as HTMLElement | null
      if (p) setActivePanel(p.dataset.panel!)
    }
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // Without a project only app-level shortcuts apply.
      if (session.screen() !== 'editor') {
        const kb = t.closest('input, textarea, select') ? undefined : matchKeybinding(app, e, null)
        if (kb && ['project.open', 'app.settings', 'app.quit'].includes(kb.command)) { e.preventDefault(); app.run(kb.command) }
        return
      }
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
      <Switch>
        <Match when={session.screen() === 'home'}>
          <Home app={app} session={session} />
        </Match>
        <Match when={session.screen() === 'editor'}>
          <Workbench app={app} />
        </Match>
      </Switch>
      <Show when={modal() === 'project'}>
        <ProjectSettingsModal app={app} onClose={() => setModal(null)} />
      </Show>
      <Show when={modal() === 'settings'}>
        <SettingsModal app={app} onClose={() => setModal(null)} />
      </Show>
      <Show when={modal() === 'rename'}>
        <RenameModal app={app} onClose={() => setModal(null)} />
      </Show>
      <Show when={true}>
        <MenuLayer />
        <TooltipLayer />
        <ToastLayer />
      </Show>
    </div>
  )
}

function RenameModal(props: { app: CascadeApp; onClose: () => void }) {
  const [name, setName] = createSignal(props.app.project().name)
  const commit = () => {
    const v = name().trim()
    if (v && v !== props.app.project().name) props.app.edit.renameProject(v)
    props.onClose()
  }
  return (
    <Modal title="Rename project" width={360} onClose={props.onClose} footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" onClick={commit}>Rename</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); commit() }}>
        <TextField value={name()} onInput={setName} onChange={setName} autofocus />
      </form>
    </Modal>
  )
}
