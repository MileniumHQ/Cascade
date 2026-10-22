import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { CascadeApp } from '@core/app'
import {
  assignKey,
  defaultSlots,
  findConflicts,
  KEYBINDING_OVERRIDES_SETTING,
  keysOf,
  normalizeKey,
  parseSlot,
  removeKey,
  resetSlot,
  sanitizeOverrides,
  scopeOf,
  slotId,
  type KeyOverrides,
  type KeySlot
} from '@core/keymap'
import { Icon } from '../ui/icon'
import { Button, IconButton, Kbd, TextField } from '../ui/kit'
import { useRegistry, useValue } from '../ui/reactive'
import { eventKey } from './keys'

interface Row {
  id: string
  slot: KeySlot
  title: string
  category: string
  /** The panel the binding is limited to, if any. */
  when?: string
}

/** Settings → Keyboard: every command with its keys; click a row's "+" to record a new shortcut. */
export function KeyboardSettings(props: { app: CascadeApp }) {
  const { app } = props
  const commands = useRegistry(app.registries.commands)
  const bindings = useRegistry(app.registries.keybindings)
  const values = useValue(app.settings.values)
  const [query, setQuery] = createSignal('')
  /** The slot being recorded (and, after a clash, the key waiting for confirmation). */
  const [recording, setRecording] = createSignal<{ id: string; replace?: string } | null>(null)
  const [pending, setPending] = createSignal<{ id: string; key: string; replace?: string; clashes: string[] } | null>(null)

  const overrides = createMemo<KeyOverrides>(() => sanitizeOverrides(values()[KEYBINDING_OVERRIDES_SETTING]))
  const save = (next: KeyOverrides) => app.settings.set(KEYBINDING_OVERRIDES_SETTING, next)

  const rows = createMemo<Row[]>(() => {
    const defaults = defaultSlots(bindings())
    const out: Row[] = []
    for (const c of commands()) {
      const slots = new Map<string, KeySlot>()
      for (const [id] of defaults) {
        const s = parseSlot(id)
        if (s.command === c.id) slots.set(id, s)
      }
      for (const id of Object.keys(overrides())) {
        const s = parseSlot(id)
        if (s.command === c.id) slots.set(id, s)
      }
      if (!slots.size) slots.set(c.id, { command: c.id })
      for (const [id, slot] of slots) {
        out.push({ id, slot, title: slot.args?.length ? `${c.title} (${slot.args.join(', ')})` : c.title, category: c.category ?? 'General', when: scopeOf(bindings(), slot) })
      }
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
  })
  const label = (id: string) => rows().find((r) => r.id === id)?.title ?? id

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return rows()
    const normalized = normalizeKey(q.replace(/\s+/g, ''))
    return rows().filter((r) => `${r.title} ${r.category}`.toLowerCase().includes(q) || keysOf(bindings(), overrides(), r.slot).some((k) => k.toLowerCase().includes(q) || k === normalized))
  })
  const groups = createMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of filtered()) map.set(r.category, [...(map.get(r.category) ?? []), r])
    return [...map.entries()]
  })

  const commit = (id: string, key: string, replace?: string) => {
    save(assignKey(bindings(), overrides(), parseSlot(id), key, { replace }))
    setPending(null)
    setRecording(null)
  }

  // While recording, swallow every key so the editor's own shortcuts stay quiet.
  const onKey = (e: KeyboardEvent) => {
    const rec = recording()
    if (!rec) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.key === 'Escape') return setRecording(null)
    const key = eventKey(e)
    if (!key) return
    const slot = parseSlot(rec.id)
    const clashes = findConflicts(bindings(), overrides(), slot, key, scopeOf(bindings(), slot)).map((c) => c.slot)
    if (clashes.length) {
      setPending({ id: rec.id, key: normalizeKey(key), replace: rec.replace, clashes })
      setRecording(null)
    } else commit(rec.id, key, rec.replace)
  }
  window.addEventListener('keydown', onKey, true)
  onCleanup(() => window.removeEventListener('keydown', onKey, true))

  const startRecording = (id: string, replace?: string) => {
    setPending(null)
    setRecording({ id, replace })
  }
  const customCount = () => Object.keys(overrides()).length

  return (
    <div class="keys">
      <div class="keys-head">
        <TextField value={query()} onChange={setQuery} onInput={setQuery} placeholder="Search commands or keys" icon="search" class="keys-search" />
        <Button size="sm" icon="rotate-ccw" disabled={!customCount()} onClick={() => save({})}>
          Reset all
        </Button>
      </div>
      <Show when={!groups().length}>
        <p class="hint">No commands match.</p>
      </Show>
      <For each={groups()}>
        {([category, list]) => (
          <section class="keys-group">
            <div class="keys-category">{category}</div>
            <For each={list}>
              {(row) => {
                const keys = () => keysOf(bindings(), overrides(), row.slot)
                const custom = () => row.id in overrides()
                const isRecording = () => recording()?.id === row.id
                const clash = () => (pending()?.id === row.id ? pending() : null)
                return (
                  <div class={`keys-row ${custom() ? 'custom' : ''}`}>
                    <div class="keys-title">
                      <span>{row.title}</span>
                      <Show when={row.when}>
                        <em>in {row.when}</em>
                      </Show>
                    </div>
                    <div class="keys-keys">
                      <For each={keys()}>
                        {(k) => (
                          <span class={`keys-chip ${isRecording() && recording()?.replace === k ? 'recording' : ''}`}>
                            <button class="keys-chip-key" data-tip="Change shortcut" onClick={() => startRecording(row.id, k)}>
                              <Kbd keys={k} />
                            </button>
                            <button class="keys-chip-x" data-tip="Remove shortcut" onClick={() => save(removeKey(bindings(), overrides(), row.slot, k))}>
                              <Icon name="x" size={11} />
                            </button>
                          </span>
                        )}
                      </For>
                      <Show when={isRecording() && !recording()?.replace}>
                        <span class="keys-record">Press a shortcut…</span>
                      </Show>
                      <Show when={isRecording() && recording()?.replace}>
                        <span class="keys-record">Press the new shortcut…</span>
                      </Show>
                      <Show when={!isRecording()}>
                        <IconButton icon="plus" size="sm" tip={keys().length ? 'Add shortcut' : 'Set shortcut'} onClick={() => startRecording(row.id)} />
                      </Show>
                      <IconButton icon="rotate-ccw" size="sm" tip="Reset to default" disabled={!custom()} onClick={() => save(resetSlot(overrides(), row.slot))} />
                    </div>
                    <Show when={clash()}>
                      {(c) => (
                        <div class="keys-clash">
                          <Icon name="triangle-alert" size={13} />
                          <span>
                            <Kbd keys={c().key} /> is used by {c().clashes.map(label).join(', ')}. Assigning it removes it there.
                          </span>
                          <Button size="sm" variant="primary" onClick={() => commit(c().id, c().key, c().replace)}>
                            Reassign
                          </Button>
                          <Button size="sm" onClick={() => setPending(null)}>
                            Cancel
                          </Button>
                        </div>
                      )}
                    </Show>
                  </div>
                )
              }}
            </For>
          </section>
        )}
      </For>
    </div>
  )
}
