import type { CascadeApp } from '@core/app'
import type { MenuItemContribution, MenuLocation } from '@core/plugin-api'
import type { MenuItem } from '../ui/kit'
import type { Session } from './session'
import { shortcutFor } from './keys'
import { slotId } from '@core/keymap'

const SECTIONS: [MenuLocation, string][] = [
  ['app/file', 'File'],
  ['app/edit', 'Edit'],
  ['app/timeline', 'Timeline'],
  ['app/playback', 'Playback'],
  ['app/view', 'View'],
  ['app/help', 'Help']
]
/** Commands that make sense without an open project. */
const HOME = new Set(['project.new', 'project.open', 'app.settings', 'app.quit', 'plugins.openFolder'])

export interface AppMenu {
  label: string
  items: () => MenuItem[]
}

/**
 * The title bar's menus (File, Edit, …), built from `app/*` menu contributions. Items are
 * computed when a menu opens, so enabled/checked state is always current.
 */
export function appMenus(app: CascadeApp, session: Session): AppMenu[] {
  const shortcut = (command: string, args?: unknown[]) => shortcutFor(app, command, args)

  // An explicit label is only a fallback for commands without bindings; a rebound or unbound command shows the truth.
  const hasBinding = (m: MenuItemContribution) => app.registries.keybindings.all().some((k) => slotId(k) === slotId(m))

  const item = (m: MenuItemContribution, editor: boolean): MenuItem => {
    const command = app.registries.commands.get(m.command)
    let enabled = !!command && (editor || HOME.has(m.command))
    try { if (enabled && command?.enabled && !command.enabled(app)) enabled = false } catch { enabled = false }
    try { if (enabled && m.when && !m.when(app, undefined)) enabled = false } catch { enabled = false }
    return {
      label: m.label,
      icon: m.icon ?? command?.icon,
      disabled: !enabled,
      checked: m.checked ? editor && m.checked(app) : undefined,
      shortcut: shortcut(m.command, m.args) ?? (hasBinding(m) ? undefined : m.shortcut),
      run: () => void app.run(m.command, ...(m.args ?? []))
    }
  }

  const section = (location: MenuLocation): MenuItem[] => {
    const editor = session.screen() === 'editor'
    const list = app.registries.menus.all()
      .filter((m) => m.location === location || (location === 'app/file' && m.location === 'app/main'))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    // Groups keep the position of their first item; separators go between groups.
    const groups = new Map<string, MenuItemContribution[]>()
    for (const m of list) groups.set(m.group ?? '', [...(groups.get(m.group ?? '') ?? []), m])
    const out: MenuItem[] = []
    for (const group of groups.values()) {
      if (out.length) out.push({ separator: true })
      out.push(...group.map((m) => item(m, editor)))
    }
    return out
  }

  return SECTIONS.map(([location, label]) => ({ label, items: () => section(location) }))
}
