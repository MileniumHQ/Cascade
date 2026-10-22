import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { PropertyContribution } from '@core/plugin-api'
import type { Id } from '@shared/project'
import { Icon } from '@ui/icon'
import { Popover } from '@ui/kit'
import { useProject, useRegistry } from '@ui/reactive'
import { clipOf } from './context'
import { setCardCollapsed } from './state'

// ───────────────────────────── search ─────────────────────────────

const subsequence = (q: string, s: string) => {
  let i = 0
  for (const c of s) if (c === q[i]) i++
  return i === q.length
}

/** Higher is better; -1 = no match. Every whitespace-separated token must match somewhere. */
export function scoreProperty(p: PropertyContribution, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 0
  const name = p.name.toLowerCase()
  const desc = p.description.toLowerCase()
  const cat = p.category.toLowerCase()
  const kw = (p.keywords ?? []).map((k) => k.toLowerCase())
  let total = 0
  for (const t of tokens) {
    let s = -1
    if (name.startsWith(t)) s = 100
    else if (name.split(/[\s-]+/).some((w) => w.startsWith(t))) s = 90
    else if (name.includes(t)) s = 80
    else if (kw.some((k) => k.startsWith(t))) s = 70
    else if (kw.some((k) => k.includes(t))) s = 55
    else if (cat.includes(t)) s = 40
    else if (desc.includes(t)) s = 30
    else if (t.length > 2 && subsequence(t, name)) s = 15
    if (s < 0) return -1
    total += s
  }
  return total
}

/**
 * Menu order for the built-in categories, roughly the order an editor reaches for them. Categories
 * from user plugins sort after these, in registration order.
 */
const CATEGORY_ORDER = ['Transform', 'Compositing', 'Time', 'Text', 'Color', 'Blur', 'Stylize', 'Shape', 'Audio']
const categoryRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c)
  return i < 0 ? CATEGORY_ORDER.length : i
}

interface Entry {
  contrib: PropertyContribution
  index: number
}
interface Group {
  category: string
  entries: Entry[]
}

// ───────────────────────────── reveal ─────────────────────────────

/** Expand, select, scroll to and briefly highlight a freshly added property card. */
export function revealProperty(app: CascadeAPI, id: Id | null) {
  if (!id) return
  setCardCollapsed(id, false)
  app.selection.property.set(id)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.ins-card[data-pid="${id}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el.classList.add('just-added')
      setTimeout(() => el.classList.remove('just-added'), 1400)
    })
  )
}

// ───────────────────────────── popover ─────────────────────────────

function AddPropertyPopover(props: { app: CascadeAPI; clipId: Id; anchor: HTMLElement; onClose: () => void; align?: 'start' | 'end' }) {
  const { app, clipId } = props
  const project = useProject(app)
  const contribs = useRegistry(app.registries.properties)
  const [query, setQuery] = createSignal('')
  const [active, setActive] = createSignal(0)
  let list!: HTMLDivElement
  let input!: HTMLInputElement

  const groups = createMemo<Group[]>(() => {
    project()
    const clip = clipOf(app, clipId)
    if (!clip) return []
    const q = query().trim()
    const scored: { contrib: PropertyContribution; score: number }[] = []
    for (const c of contribs()) {
      if (!app.edit.propertyApplies(c, clip)) continue
      if (!c.stackable && clip.properties.some((p) => p.type === c.id)) continue
      const score = scoreProperty(c, q)
      if (score >= 0) scored.push({ contrib: c, score })
    }
    const byCat = new Map<string, { contrib: PropertyContribution; score: number }[]>()
    for (const s of scored) {
      const list = byCat.get(s.contrib.category) ?? []
      list.push(s)
      byCat.set(s.contrib.category, list)
    }
    let cats = [...byCat.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]))
    if (q) {
      for (const [, items] of cats) items.sort((a, b) => b.score - a.score)
      cats.sort((a, b) => b[1][0].score - a[1][0].score)
    }
    let i = 0
    return cats.map(([category, items]) => ({ category, entries: items.map((s) => ({ contrib: s.contrib, index: i++ })) }))
  })
  const flat = createMemo(() => groups().flatMap((g) => g.entries))

  createEffect(() => {
    query()
    setActive(0)
  })
  createEffect(() => {
    const i = active()
    list?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  })
  onMount(() => input.focus())

  const add = (c: PropertyContribution) => {
    const id = app.edit.addProperty(clipId, c.id)
    props.onClose()
    revealProperty(app, id)
  }
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation()
    const n = flat().length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (n) setActive((active() + 1) % n)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) setActive((active() - 1 + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = flat()[active()]
      if (entry) add(entry.contrib)
    }
  }

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={340} align={props.align} class="ins-add">
      <div class="ins-add-search">
        <Icon name="search" size={14} />
        <input
          ref={input}
          placeholder="Search properties…"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <kbd>Esc</kbd>
      </div>
      <div class="ins-add-list" ref={list}>
        <For each={groups()}>
          {(g) => (
            <div class="ins-add-group">
              <div class="ins-add-cat">{g.category}</div>
              <For each={g.entries}>
                {(e) => (
                  <div
                    class="ins-add-item"
                    classList={{ active: active() === e.index }}
                    data-idx={e.index}
                    onPointerMove={() => active() !== e.index && setActive(e.index)}
                    onClick={() => add(e.contrib)}
                  >
                    <span class="ins-add-icon">
                      <Icon name={e.contrib.icon} size={15} />
                    </span>
                    <span class="ins-add-text">
                      <span class="ins-add-name">{e.contrib.name}</span>
                      <span class="ins-add-desc">{e.contrib.description}</span>
                    </span>
                    <Show when={active() === e.index}>
                      <kbd class="ins-add-enter">↵</kbd>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
        <Show when={!flat().length}>
          <div class="ins-add-none">{query().trim() ? `No properties match “${query().trim()}”` : 'Every available property is already on this clip'}</div>
        </Show>
      </div>
    </Popover>
  )
}

/** Wraps any trigger element; clicking it toggles the searchable "add property" dropdown. */
export function AddPropertyAnchor(props: {
  app: CascadeAPI
  clipId: () => Id | null
  align?: 'start' | 'end'
  children: (p: { open: boolean; toggle: (anchor: HTMLElement) => void }) => JSX.Element
}) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  return (
    <>
      {props.children({
        // lazy: reading it eagerly would re-create the trigger (and detach the popover anchor) on every toggle
        get open() {
          return !!anchor()
        },
        toggle: (el) => setAnchor(anchor() ? null : el)
      })}
      <Show when={anchor() && props.clipId()} keyed>
        {(clipId) => <AddPropertyPopover app={props.app} clipId={clipId} anchor={anchor()!} align={props.align} onClose={() => setAnchor(null)} />}
      </Show>
    </>
  )
}
