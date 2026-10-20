import type { CascadeAPI } from '@core/app'
import type { KeybindingContribution } from '@core/plugin-api'

const isMac = navigator.platform.includes('Mac')

/** Normalize a KeyboardEvent to "Mod+Shift+Alt+Key". */
export function eventKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  let k = e.key
  if (k === ' ') k = 'Space'
  else if (k === '+') k = 'Plus'
  else if (k.length === 1) k = k.toUpperCase()
  if (e.code.startsWith('Digit')) k = e.code.slice(5)
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return ''
  parts.push(k)
  return parts.join('+')
}

const normalize = (k: string) =>
  k
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .sort((a, b) => order(a) - order(b))
    .join('+')
const order = (p: string) => (p === 'Mod' ? 0 : p === 'Shift' ? 1 : p === 'Alt' ? 2 : 3)

export function matchKeybinding(app: CascadeAPI, e: KeyboardEvent, activePanel: string | null): KeybindingContribution | undefined {
  const key = eventKey(e)
  if (!key) return undefined
  const all = app.registries.keybindings.all().filter((kb) => normalize(kb.key) === key)
  // Panel-scoped bindings win over global ones.
  return all.find((kb) => kb.when && kb.when === activePanel) ?? all.find((kb) => !kb.when)
}

/** Shortcut label for a command (for menus/tooltips). */
export function shortcutFor(app: CascadeAPI, command: string): string | undefined {
  return app.registries.keybindings.all().find((k) => k.command === command && !k.args)?.key
}
