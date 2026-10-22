import type { CascadeAPI } from '@core/app'
import { effectiveBindings, KEYBINDING_OVERRIDES_SETTING, sanitizeOverrides, slotId, type EffectiveBinding, type KeyOverrides } from '@core/keymap'

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

const overridesOf = (app: CascadeAPI): KeyOverrides => sanitizeOverrides(app.settings.get(KEYBINDING_OVERRIDES_SETTING))

let cache: { rev: number; raw: unknown; app: CascadeAPI; list: EffectiveBinding[] } | undefined
/** Registered bindings with the user's overrides applied (cached until either changes). */
export function bindingsOf(app: CascadeAPI): EffectiveBinding[] {
  const rev = app.registries.keybindings.revision
  const raw = app.settings.values.get()[KEYBINDING_OVERRIDES_SETTING]
  if (cache?.app === app && cache.rev === rev && cache.raw === raw) return cache.list
  const list = effectiveBindings(app.registries.keybindings.all(), overridesOf(app))
  cache = { rev, raw, app, list }
  return list
}

export function matchKeybinding(app: CascadeAPI, e: KeyboardEvent, activePanel: string | null): EffectiveBinding | undefined {
  const key = eventKey(e)
  if (!key) return undefined
  const all = bindingsOf(app).filter((kb) => kb.key === key)
  // Panel-scoped bindings win over global ones.
  return all.find((kb) => kb.when && kb.when === activePanel) ?? all.find((kb) => !kb.when)
}

/** Shortcut for a command (for menus/tooltips), honouring the user's overrides. */
export function shortcutFor(app: CascadeAPI, command: string, args?: unknown[]): string | undefined {
  const id = slotId({ command, args })
  return bindingsOf(app).find((k) => slotId(k) === id)?.key
}
