import { createMemo, createSignal, For, Show } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { fpsValue } from '@shared/time'
import logo from '../assets/logo.svg'
import { Icon } from '../ui/icon'
import { IconButton, openMenu, openMenuAnchor } from '../ui/kit'
import { useEmitter, useProject } from '../ui/reactive'
import type { Session } from './session'
import { appMenus, type AppMenu } from './menu'

export function TitleBar(props: { app: CascadeApp; session: Session }) {
  const { app, session } = props
  const project = useProject(app)
  const history = useEmitter(app.doc.onHistory as never, () => ({ undo: app.doc.canUndo, redo: app.doc.canRedo, dirty: app.doc.dirty, u: app.doc.undoLabel, r: app.doc.redoLabel }))
  const [renaming, setRenaming] = createSignal(false)
  const menuOpenOn = createMemo(() => {
    const a = openMenuAnchor()
    return a instanceof HTMLElement && a.classList.contains('tb-menu') ? a.textContent : null
  })

  const fpsLabel = () => {
    const v = fpsValue(project().settings.fps)
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '')
  }

  const menus = appMenus(app, session)
  const open = (e: { currentTarget: HTMLElement }, m: AppMenu) => openMenu(e.currentTarget, m.items())

  return (
    <header class="titlebar">
      <img class="tb-logo" src={logo} alt="" draggable={false} />
      <nav class="tb-menus">
        <For each={menus}>
          {(m) => (
            <button
              class="tb-menu"
              classList={{ open: menuOpenOn() === m.label }}
              onClick={(e) => open(e, m)}
              // Like a native menu bar: once one menu is open, hovering another switches to it.
              onPointerEnter={(e) => {
                const a = openMenuAnchor()
                if (a instanceof HTMLElement && a.classList.contains('tb-menu') && a !== e.currentTarget) open(e, m)
              }}
            >
              {m.label}
            </button>
          )}
        </For>
      </nav>
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
        <button class="tb-pill tnum" onClick={() => app.run('project.settings')} data-tip="Project settings">
          {project().settings.width} × {project().settings.height}
          <i />
          {fpsLabel()} fps
        </button>
      </Show>
      {/* Native window controls (titleBarOverlay) are drawn here by Electron. */}
      <div class="tb-controls" />
    </header>
  )
}
