import { createMemo, createResource, createSignal, For, onMount, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { Icon } from '@ui/icon'
import { Popover } from '@ui/kit'
import { BUILTIN_FONTS as BUILTIN } from './fonts'
import './font-picker.css'
const ROW_H = 30
const LIST_H = 330

let systemFonts: Promise<string[]> | null = null
const loadFonts = (app: CascadeAPI) => (systemFonts ??= app.host?.fonts().catch(() => []) ?? Promise.resolve([]))

// The editor window registers the bundled Inter as 'Inter Variable' (the stage aliases it to 'Inter').
const cssFamily = (f: string) => (f === 'Inter' ? `'Inter Variable', 'Inter'` : BUILTIN.includes(f) ? f : `"${f.replace(/"/g, '')}"`)

/** Font family picker: every installed family, each previewed in its own face, with search. */
export function FontPicker(props: { app: CascadeAPI; value: string; onChange: (font: string) => void }) {
  const [open, setOpen] = createSignal(false)
  let btn!: HTMLButtonElement
  return (
    <>
      <button ref={btn} class={`select font-select ${open() ? 'open' : ''}`} onClick={() => setOpen(!open())}>
        <span class="select-label" style={{ 'font-family': cssFamily(props.value) }}>
          {props.value}
        </span>
        <Icon name="chevron-down" size={13} class="select-chev" />
      </button>
      <Show when={open()}>
        <Popover anchor={btn} onClose={() => setOpen(false)} width={300} class="font-pop">
          <FontList app={props.app} value={props.value} onPick={(f) => (props.onChange(f), setOpen(false))} />
        </Popover>
      </Show>
    </>
  )
}

function FontList(props: { app: CascadeAPI; value: string; onPick: (font: string) => void }) {
  const [fonts] = createResource(() => loadFonts(props.app))
  const [query, setQuery] = createSignal('')
  const [scroll, setScroll] = createSignal(0)
  const [active, setActive] = createSignal(0)
  let input!: HTMLInputElement
  let list!: HTMLDivElement

  const all = createMemo(() => {
    const sys = (fonts() ?? []).filter((f) => !BUILTIN.includes(f))
    return [...BUILTIN, ...sys]
  })
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase()
    return q ? all().filter((f) => f.toLowerCase().includes(q)) : all()
  })
  // Only the visible rows are rendered: each one loads its font face.
  const slice = createMemo(() => {
    const first = Math.max(0, Math.floor(scroll() / ROW_H) - 4)
    const last = Math.min(shown().length, Math.ceil((scroll() + LIST_H) / ROW_H) + 4)
    return shown()
      .slice(first, last)
      .map((f, i) => ({ f, i: first + i }))
  })

  const reveal = (i: number) => {
    const top = i * ROW_H
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_H > list.scrollTop + LIST_H) list.scrollTop = top + ROW_H - LIST_H
  }
  onMount(() => {
    input.focus()
    const i = all().indexOf(props.value)
    if (i > 0) {
      setActive(i)
      list.scrollTop = Math.max(0, i * ROW_H - LIST_H / 2)
    }
  })
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = Math.max(0, Math.min(shown().length - 1, active() + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(i)
      reveal(i)
    } else if (e.key === 'Enter') {
      const f = shown()[active()]
      if (f) props.onPick(f)
    }
  }

  return (
    <div class="font-list-wrap">
      <div class="font-search">
        <Icon name="search" size={13} />
        <input
          ref={input}
          placeholder={fonts.loading ? 'Loading fonts…' : `Search ${all().length} fonts`}
          value={query()}
          onInput={(e) => (setQuery(e.currentTarget.value), setActive(0), (list.scrollTop = 0))}
          onKeyDown={key}
        />
      </div>
      <div class="font-list" ref={list} style={{ height: `${LIST_H}px` }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: `${shown().length * ROW_H}px`, position: 'relative' }}>
          <For each={slice()}>
            {(row) => (
              <button
                class="font-row"
                classList={{ on: row.f === props.value, active: row.i === active() }}
                style={{ top: `${row.i * ROW_H}px`, height: `${ROW_H}px` }}
                onPointerEnter={() => setActive(row.i)}
                onClick={() => props.onPick(row.f)}
              >
                <span style={{ 'font-family': cssFamily(row.f) }}>{row.f}</span>
                <Show when={row.f === props.value}>
                  <Icon name="check" size={13} />
                </Show>
              </button>
            )}
          </For>
        </div>
        <Show when={!shown().length && !fonts.loading}>
          <div class="font-empty">No fonts match</div>
        </Show>
      </div>
    </div>
  )
}
