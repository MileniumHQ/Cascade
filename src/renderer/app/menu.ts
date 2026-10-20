import { createEffect, onCleanup } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { MenuItemContribution, MenuLocation } from '@core/plugin-api'
import type { NativeMenuItem } from '@shared/ipc'
import type { Session } from './session'

const SECTIONS: [MenuLocation, string][] = [
  ['app/file', '&File'],
  ['app/edit', '&Edit'],
  ['app/timeline', '&Timeline'],
  ['app/playback', '&Playback'],
  ['app/view', '&View'],
  ['app/help', '&Help']
]
/** Commands that make sense without an open project. */
const HOME = new Set(['project.new', 'project.open', 'app.settings', 'app.quit', 'plugins.openFolder'])

const KEYS: Record<string, string> = { Mod: 'CmdOrCtrl', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', '=': '=', '+': 'Plus' }
/** Keymap notation ("Mod+Shift+Z") → Electron accelerator label. */
export const accelerator = (key: string) => key.split('+').map((part) => KEYS[part] ?? part).join('+')

/**
 * Builds the native application menu from `app/*` menu contributions and keeps it in sync with
 * registry changes, the open screen and the state checkboxes/enabled flags depend on.
 */
export function installNativeMenu(app: CascadeApp, session: Session) {
  const host = app.host
  if (!host?.window.setMenu) return
  const actions = new Map<string, () => void>()

  const build = () => {
    actions.clear()
    const editor = session.screen() === 'editor'
    const items = app.registries.menus.all().filter((m) => m.location.startsWith('app/'))
    const shortcut = (command: string, args?: unknown[]) =>
      app.registries.keybindings.all().find((k) => k.command === command && JSON.stringify(k.args ?? []) === JSON.stringify(args ?? []))?.key

    const item = (m: MenuItemContribution): NativeMenuItem => {
      const id = m.id
      actions.set(id, () => void app.run(m.command, ...(m.args ?? [])))
      const command = app.registries.commands.get(m.command)
      const key = m.shortcut ?? shortcut(m.command, m.args)
      let enabled = !!command && (editor || HOME.has(m.command))
      try { if (enabled && command?.enabled && !command.enabled(app)) enabled = false } catch { enabled = false }
      try { if (enabled && m.when && !m.when(app, undefined)) enabled = false } catch { enabled = false }
      return {
        id, label: m.label, enabled,
        ...(m.checked ? { type: 'checkbox' as const, checked: editor && m.checked(app) } : {}),
        ...(key ? { accelerator: accelerator(key) } : {})
      }
    }

    const section = (location: MenuLocation): NativeMenuItem[] => {
      const list = items.filter((m) => m.location === location || (location === 'app/file' && m.location === 'app/main'))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      // Groups keep the position of their first item; separators go between groups.
      const groups = new Map<string, MenuItemContribution[]>()
      for (const m of list) groups.set(m.group ?? '', [...(groups.get(m.group ?? '') ?? []), m])
      const out: NativeMenuItem[] = []
      for (const group of groups.values()) {
        if (out.length) out.push({ type: 'separator' })
        out.push(...group.map(item))
      }
      return out
    }

    const menu: NativeMenuItem[] = []
    for (const [location, label] of SECTIONS) {
      const submenu = section(location)
      if (location === 'app/view') submenu.push({ type: 'separator' }, { role: 'togglefullscreen', label: 'Full Screen' })
      if (location === 'app/view' && import.meta.env.DEV) submenu.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
      if (submenu.length) menu.push({ label, submenu })
    }
    host.window.setMenu(menu)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => { clearTimeout(timer); timer = setTimeout(build, 80) }
  const subs = [
    app.registries.menus.onChange.on(schedule),
    app.registries.commands.onChange.on(schedule),
    app.registries.keybindings.onChange.on(schedule),
    app.doc.onHistory.on(schedule),
    app.selection.clips.subscribe(schedule),
    app.view.snapping.subscribe(schedule),
    app.playback.loop.subscribe(schedule)
  ]
  createEffect(() => { session.screen(); schedule() })
  onCleanup(() => { clearTimeout(timer); for (const s of subs) s.dispose() })
  onCleanup(host.window.onMenu((id) => actions.get(id)?.()))
}
