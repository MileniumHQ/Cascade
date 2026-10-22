import type { KeybindingContribution } from './plugin-api'

/**
 * Key bindings are contributions; users override them per "slot" (a command plus its arguments, so
 * "step 1 frame" and "step 10 frames" are separate slots). An override replaces every default key
 * of its slot; an empty list unbinds the slot. Overrides persist in app settings (SETTING_ID).
 */
export const KEYBINDING_OVERRIDES_SETTING = 'keybindings.overrides'

export type KeyOverrides = Record<string, string[]>

export interface KeySlot {
  command: string
  args?: unknown[]
}

export const slotId = (slot: KeySlot): string => (slot.args?.length ? `${slot.command}#${JSON.stringify(slot.args)}` : slot.command)
export const parseSlot = (id: string): KeySlot => {
  const i = id.indexOf('#')
  if (i < 0) return { command: id }
  try {
    const args = JSON.parse(id.slice(i + 1))
    return Array.isArray(args) ? { command: id.slice(0, i), args } : { command: id.slice(0, i) }
  } catch {
    return { command: id.slice(0, i) }
  }
}

const MOD_ORDER: Record<string, number> = { Mod: 0, Shift: 1, Alt: 2 }
const modOrder = (p: string) => MOD_ORDER[p] ?? 3

/** Canonical "Mod+Shift+Alt+Key" form so "shift+mod+z" and "Mod+Shift+Z" compare equal. */
export function normalizeKey(key: string): string {
  const parts = key.split('+').filter(Boolean)
  // A trailing "+" key is written "Plus" in bindings.
  return parts
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .sort((a, b) => modOrder(a) - modOrder(b))
    .join('+')
}

export const isModifierOnly = (key: string) => key === '' || key.split('+').every((p) => p in MOD_ORDER)

/** A binding as it is actually used: registry defaults with user overrides applied. */
export interface EffectiveBinding {
  id: string
  command: string
  args?: unknown[]
  /** Normalized key. */
  key: string
  when?: string
  /** True when the user changed it. */
  custom: boolean
}

/** Registry defaults grouped by slot, in registration order. */
export function defaultSlots(bindings: KeybindingContribution[]): Map<string, KeybindingContribution[]> {
  const slots = new Map<string, KeybindingContribution[]>()
  for (const b of bindings) {
    const id = slotId(b)
    slots.set(id, [...(slots.get(id) ?? []), b])
  }
  return slots
}

export function effectiveBindings(bindings: KeybindingContribution[], overrides: KeyOverrides = {}): EffectiveBinding[] {
  const out: EffectiveBinding[] = []
  const defaults = defaultSlots(bindings)
  for (const [id, list] of defaults) {
    const override = overrides[id]
    if (override) continue
    for (const b of list) out.push({ id: b.id, command: b.command, args: b.args, key: normalizeKey(b.key), when: b.when, custom: false })
  }
  for (const [id, keys] of Object.entries(overrides)) {
    const slot = parseSlot(id)
    const when = defaults.get(id)?.[0]?.when
    for (const key of keys) out.push({ id: `${id}:${key}`, command: slot.command, args: slot.args, key: normalizeKey(key), when, custom: true })
  }
  return out
}

/** The keys a slot currently has (defaults unless overridden), in display form. */
export function keysOf(bindings: KeybindingContribution[], overrides: KeyOverrides, slot: KeySlot): string[] {
  const id = slotId(slot)
  if (overrides[id]) return overrides[id].map(normalizeKey)
  return (defaultSlots(bindings).get(id) ?? []).map((b) => normalizeKey(b.key))
}

export interface KeyConflict {
  slot: string
  command: string
  args?: unknown[]
}

/** Other slots that already use `key` in the same scope (the same `when`, or both global). */
export function findConflicts(bindings: KeybindingContribution[], overrides: KeyOverrides, slot: KeySlot, key: string, when?: string): KeyConflict[] {
  const mine = slotId(slot)
  const norm = normalizeKey(key)
  const seen = new Set<string>()
  const out: KeyConflict[] = []
  for (const b of effectiveBindings(bindings, overrides)) {
    const id = slotId(b)
    if (id === mine || b.key !== norm || (b.when ?? '') !== (when ?? '') || seen.has(id)) continue
    seen.add(id)
    out.push({ slot: id, command: b.command, args: b.args })
  }
  return out
}

/** The scope (`when`) a new key for `slot` takes: that of the slot's defaults. */
export function scopeOf(bindings: KeybindingContribution[], slot: KeySlot): string | undefined {
  return defaultSlots(bindings).get(slotId(slot))?.[0]?.when
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i])

/**
 * Assign `key` to a slot (adding to its keys), removing it from any slot that conflicts.
 * Returns the new overrides; overrides equal to the defaults are dropped.
 */
export function assignKey(bindings: KeybindingContribution[], overrides: KeyOverrides, slot: KeySlot, key: string, opts: { replace?: string } = {}): KeyOverrides {
  const norm = normalizeKey(key)
  const next: KeyOverrides = { ...overrides }
  const when = scopeOf(bindings, slot)
  for (const c of findConflicts(bindings, overrides, slot, norm, when)) {
    next[c.slot] = keysOf(bindings, next, parseSlot(c.slot)).filter((k) => k !== norm)
  }
  const mine = slotId(slot)
  const current = keysOf(bindings, next, slot)
  const keys = opts.replace ? current.filter((k) => k !== normalizeKey(opts.replace!)) : current
  next[mine] = keys.includes(norm) ? keys : [...keys, norm]
  return prune(bindings, next)
}

/** Remove one key from a slot. */
export function removeKey(bindings: KeybindingContribution[], overrides: KeyOverrides, slot: KeySlot, key: string): KeyOverrides {
  const norm = normalizeKey(key)
  return prune(bindings, { ...overrides, [slotId(slot)]: keysOf(bindings, overrides, slot).filter((k) => k !== norm) })
}

/** Back to the registered keys for one slot. */
export function resetSlot(overrides: KeyOverrides, slot: KeySlot): KeyOverrides {
  const next = { ...overrides }
  delete next[slotId(slot)]
  return next
}

/** Drop overrides that match what the registry already provides. */
function prune(bindings: KeybindingContribution[], overrides: KeyOverrides): KeyOverrides {
  const defaults = defaultSlots(bindings)
  const out: KeyOverrides = {}
  for (const [id, keys] of Object.entries(overrides)) {
    const def = (defaults.get(id) ?? []).map((b) => normalizeKey(b.key))
    if (!sameKeys([...keys].sort(), [...def].sort())) out[id] = keys
  }
  return out
}

/** Only well-formed overrides survive loading (settings files can be edited by hand). */
export function sanitizeOverrides(value: unknown): KeyOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: KeyOverrides = {}
  for (const [id, keys] of Object.entries(value)) {
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) continue
    const valid = keys.map(normalizeKey).filter((k) => k && !isModifierOnly(k))
    if (valid.length || !keys.length) out[id] = valid
  }
  return out
}
