import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { fpsValue } from '@shared/time'
import logo from '../assets/logo.svg'
import { Icon } from '../ui/icon'
import { IconButton, openMenu } from '../ui/kit'
import { useEmitter, useProject } from '../ui/reactive'
import type { Session } from './session'
import { ProjectSettingsModal } from './ProjectSettings'
import { SettingsModal } from './Settings'

export function TitleBar(props: { app: CascadeApp; session: Session }) {
  const { app, session } = props
  const project = useProject(app)
  const history = useEmitter(app.doc.onHistory as never, () => ({ undo: app.doc.canUndo, redo: app.doc.canRedo, dirty: app.doc.dirty, u: app.doc.undoLabel, r: app.doc.redoLabel }))
  const [maximized, setMaximized] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [projSettings, setProjSettings] = createSignal(false)
  const [settings, setSettings] = createSignal(false)
  onMount(() => onCleanup(app.host!.window.onMaximizeChange(setMaximized)))

  const fpsLabel = () => {
    const v = fpsValue(project().settings.fps)
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '')
  }

  const mainMenu = (e: MouseEvent) =>
    openMenu(e.currentTarget as HTMLElement, [
      { label: 'New project', icon: 'file-plus', run: () => void session.close() },
      { label: 'Open project…', icon: 'folder-open', shortcut: 'Mod+O', run: () => void session.openDialog() },
      { label: 'Save', icon: 'save', shortcut: 'Mod+S', run: () => void session.save(), disabled: session.screen() !== 'editor' },
      { label: 'Save as…', icon: 'save-all', shortcut: 'Mod+Shift+S', run: () => void session.saveAs(), disabled: session.screen() !== 'editor' },
      { separator: true },
      { label: 'Import media…', icon: 'import', shortcut: 'Mod+I', run: () => app.run('media.import'), disabled: session.screen() !== 'editor' },
      { label: 'Project settings…', icon: 'sliders-horizontal', run: () => setProjSettings(true), disabled: session.screen() !== 'editor' },
      { separator: true },
      { label: 'Settings…', icon: 'settings', shortcut: 'Mod+,', run: () => setSettings(true) },
      { label: 'Open plugins folder', icon: 'puzzle', run: () => app.host!.plugins.openFolder() },
      { separator: true },
      { label: 'Close project', icon: 'x', run: () => void session.close(), disabled: session.screen() !== 'editor' },
      { label: 'Quit', icon: 'log-out', run: () => app.host!.window.close() }
    ])

  return (
    <header class="titlebar">
      <button class="tb-brand" onClick={mainMenu} data-tip="Menu">
        <img src={logo} alt="" draggable={false} />
        <span>Cascade</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <Show when={session.screen() === 'editor'}>
        <div class="tb-crumb">
          <Show
            when={renaming()}
            fallback={
              <span class="tb-project" onDblClick={() => setRenaming(true)} data-tip="Double-click to rename">
                {project().name}
              </span>
            }
          >
            <input
              class="tb-rename"
              value={project().name}
              ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim()
                if (v && v !== project().name) app.edit.renameProject(v)
                setRenaming(false)
              }}
            />
          </Show>
          <Icon name="chevron-right" size={12} class="tb-sep" />
          <span class="tb-timeline">{project().timelines[project().activeTimeline]?.name}</span>
          <Show when={history().dirty}>
            <span class="tb-dirty" data-tip={session.saving() ? 'Saving…' : 'Unsaved changes (autosaves)'} />
          </Show>
        </div>
        <div class="tb-actions">
          <IconButton icon="undo-2" size="sm" disabled={!history().undo} tip={history().u ? `Undo ${history().u}` : 'Undo'} kbd="Mod+Z" onClick={() => app.doc.undo()} />
          <IconButton icon="redo-2" size="sm" disabled={!history().redo} tip={history().r ? `Redo ${history().r}` : 'Redo'} kbd="Mod+Shift+Z" onClick={() => app.doc.redo()} />
        </div>
      </Show>
      <div class="tb-drag" />
      <Show when={session.screen() === 'editor'}>
        <button class="tb-pill tnum" onClick={() => setProjSettings(true)} data-tip="Project settings">
          {project().settings.width} × {project().settings.height}
          <i />
          {fpsLabel()} fps
        </button>
      </Show>
      <div class="tb-window">
        <button onClick={() => app.host!.window.minimize()} aria-label="Minimize">
          <Icon name="minus" size={14} />
        </button>
        <button onClick={() => app.host!.window.toggleMaximize()} aria-label="Maximize">
          <Icon name={maximized() ? 'copy' : 'square'} size={12} />
        </button>
        <button class="close" onClick={() => app.host!.window.close()} aria-label="Close">
          <Icon name="x" size={15} />
        </button>
      </div>
      <Show when={projSettings()}>
        <ProjectSettingsModal app={app} onClose={() => setProjSettings(false)} />
      </Show>
      <Show when={settings()}>
        <SettingsModal app={app} onClose={() => setSettings(false)} />
      </Show>
    </header>
  )
}
