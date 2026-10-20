import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { PanelContext } from '@core/plugin-api'
import { Icon } from '@ui/icon'
import { IconButton, openMenu, Popover } from '@ui/kit'
import type { SessionConfigOption } from '@shared/agents'
import { markdown } from './markdown'
import {
  active, activeId, cancel, chats, chooseProvider, closeChat, connect, draftProvider, flatOptions, newChat, providers, refreshProviders,
  respond, send, setActiveId, setOption, startChat, starting, type Chat, type Entry
} from './state'

// Simplified brand marks (inline SVG keeps them crisp at 12–24px).
const MARKS: Record<string, string> = {
  claude: '<svg viewBox="0 0 24 24"><g stroke="#d97757" stroke-width="2.6" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></g></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="#ececef" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="m8.5 10 2.5 2-2.5 2M12.5 14.5h3"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" fill="none" stroke="#ececef" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z" fill="#ececef"/></svg>',
  gemini: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#82cbff"/><stop offset="1" stop-color="#a98bff"/></linearGradient></defs><path fill="url(#gm)" d="M12 2c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10C7.3 11.4 11.4 7.3 12 2z"/></svg>',
  agent: 'bot'
}
const providerOf = (id: string) => providers().find(p => p.id === id)
function Mark(props: { provider: string; size?: number }) {
  return <Icon name={MARKS[providerOf(props.provider)?.icon ?? props.provider] ?? 'bot'} size={props.size ?? 16} class="ag-mark" />
}

const TOOL_ICONS: Record<string, string> = {
  read: 'file-text', edit: 'pencil', delete: 'trash-2', move: 'move', search: 'search', execute: 'square-terminal',
  think: 'brain', fetch: 'globe', switch_mode: 'toggle-left', other: 'wrench'
}
/** "mcp__cascade__timeline_get" → "timeline_get" with the Cascade mark. */
const toolLabel = (title: string) => {
  const m = title.match(/(?:mcp__)?cascade(?:__|\.|: ?|\/)(\w+)/i)
  return m ? { label: m[1].replace(/_/g, ' '), cascade: true } : { label: title, cascade: false }
}

export function AgentPanel(props: { ctx: PanelContext }) {
  connect(props.ctx.app.host?.agents)
  return (
    <div class="ag">
      <Show when={props.ctx.app.host?.agents} fallback={<div class="ag-empty"><p>Agents are only available in the desktop app.</p></div>}>
        <Thread />
        <Composer />
      </Show>
    </div>
  )
}

/** Header actions: chat switcher + new chat. */
export function AgentActions() {
  const openChats = (e: MouseEvent) => openMenu(e.currentTarget as HTMLElement, chats.length
    ? chats.map(c => ({ label: c.title, icon: c.id === activeId() ? 'check' : undefined, run: () => setActiveId(c.id) }))
      .concat(active() ? [{ separator: true } as never, { label: 'Close this chat', icon: 'x', danger: true, run: () => closeChat(activeId()!) } as never] : [])
    : [{ label: 'No chats yet', disabled: true }])
  return (
    <>
      <IconButton size="sm" icon="history" tip="Chats" onClick={openChats} />
      <IconButton size="sm" icon="square-pen" tip="New chat" onClick={newChat} />
    </>
  )
}

function Thread() {
  let scroller!: HTMLDivElement
  let pinned = true
  const chat = active
  const onScroll = () => { pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24 }
  // Follow streaming output unless the user scrolled up.
  const observer = new MutationObserver(() => { if (pinned) scroller.scrollTop = scroller.scrollHeight })
  onMount(() => observer.observe(scroller, { childList: true, subtree: true, characterData: true }))
  onCleanup(() => observer.disconnect())
  createEffect(on(activeId, () => { pinned = true; queueMicrotask(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight }) }))
  return (
    <div class="ag-thread" ref={scroller} onScroll={onScroll}>
      <Show when={chat()?.entries.length} fallback={<Hero />}>
        <For each={chat()!.entries}>{(entry) => <Row entry={entry} />}</For>
        <Show when={chat()!.running}><Working chat={chat()!} /></Show>
      </Show>
    </div>
  )
}

function Hero() {
  const name = () => providerOf(active()?.providerId ?? draftProvider())?.name ?? 'an agent'
  return (
    <div class="ag-hero">
      <Mark provider={active()?.providerId ?? draftProvider()} size={28} />
      <h2>What should we edit?</h2>
      <p>{name()} can see and edit this project through Cascade’s tools: cut by transcript, animate, caption, export.</p>
    </div>
  )
}

function Row(props: { entry: Entry }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Switch>
      <Match when={props.entry.kind === 'user' && props.entry}>{(e) => <div class="ag-user"><div class="ag-bubble">{e().text}</div></div>}</Match>
      <Match when={props.entry.kind === 'assistant' && props.entry}>{(e) => <div class="ag-assistant ag-md" innerHTML={markdown(e().text)} />}</Match>
      <Match when={props.entry.kind === 'thought' && props.entry}>{(e) => (
        <div class="ag-work">
          <button class="ag-work-row" onClick={() => setOpen(!open())} aria-expanded={open()}>
            <Icon name="brain" size={14} class="ag-work-icon" /><span class="ag-work-label">Thought</span>
            <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={12} class="ag-chev" />
          </button>
          <Show when={open()}><div class="ag-work-detail ag-md" innerHTML={markdown(e().text)} /></Show>
        </div>
      )}</Match>
      <Match when={props.entry.kind === 'tool' && props.entry}>{(e) => {
        const label = createMemo(() => toolLabel(e().title))
        return (
          <div class={`ag-work ag-${e().status}`}>
            <button class="ag-work-row" onClick={() => setOpen(!open())} aria-expanded={open()} disabled={!e().detail}>
              <Icon name={label().cascade ? 'clapperboard' : TOOL_ICONS[e().toolKind] ?? 'wrench'} size={14} class="ag-work-icon" />
              <span class="ag-work-label">{label().label}</span>
              <Show when={e().status === 'failed'}><Icon name="x" size={12} class="ag-fail" /></Show>
              <Show when={e().detail}><Icon name={open() ? 'chevron-down' : 'chevron-right'} size={12} class="ag-chev" /></Show>
            </button>
            <Show when={open()}><pre class="ag-work-detail">{e().detail}</pre></Show>
          </div>
        )
      }}</Match>
      <Match when={props.entry.kind === 'plan' && props.entry}>{(e) => (
        <div class="ag-plan">
          <For each={e().items}>{(item) => (
            <div class={`ag-plan-item ag-plan-${item.status}`}>
              <Icon name={item.status === 'completed' ? 'circle-check' : item.status === 'in_progress' ? 'circle-dot' : 'circle'} size={13} />
              <span>{item.content}</span>
            </div>
          )}</For>
        </div>
      )}</Match>
      <Match when={props.entry.kind === 'notice' && props.entry}>{(e) => <div class={`ag-notice ag-notice-${e().tone}`}>{e().text}</div>}</Match>
    </Switch>
  )
}

function Working(props: { chat: Chat }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const elapsed = () => {
    const s = Math.max(0, Math.round((now() - props.chat.startedAt) / 1000))
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  }
  return <div class="ag-working"><span class="ag-shine">Working</span> for {elapsed()}</div>
}

// ───────────────────────── composer ─────────────────────────

function Composer() {
  const [text, setText] = createSignal('')
  const [error, setError] = createSignal('')
  let input!: HTMLTextAreaElement
  const chat = active
  const busy = () => !!chat()?.running
  const permission = () => chat()?.permissions[0]
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px` }
  const submit = () => {
    const value = text().trim()
    if (!value || busy() || starting()) return
    setText(''); setError(''); queueMicrotask(grow)
    send(value).catch(e => setError(String(e?.message ?? e)))
  }
  const option = (category: string) => chat()?.options.find(o => o.category === category)
  const extras = () => chat()?.options.filter(o => !['model', 'thought_level', 'mode'].includes(o.category ?? '')) ?? []
  createEffect(on(activeId, () => input?.focus()))
  return (
    <div class="ag-composer-wrap">
      <Show when={permission()}>{(p) => (
        <div class="ag-approval">
          <div class="ag-approval-head"><Icon name="shield-alert" size={13} /><span>Permission needed</span>
            <Show when={chat()!.permissions.length > 1}><span class="ag-count">1/{chat()!.permissions.length}</span></Show></div>
          <div class="ag-approval-title">{toolLabel(p().toolCall.title ?? 'Tool call').label}</div>
          <Show when={p().toolCall.rawInput}><pre class="ag-approval-detail">{(() => { const i = p().toolCall.rawInput as Record<string, unknown>; return typeof i?.command === 'string' ? i.command : JSON.stringify(i, null, 1) })()}</pre></Show>
          <div class="ag-approval-actions">
            <For each={p().options}>{(o) => (
              <button class={`ag-pill ${o.kind.startsWith('allow') ? (o.kind === 'allow_once' ? 'primary' : '') : 'outline'}`} onClick={() => respond(p().requestId, o.optionId)}>{o.name}</button>
            )}</For>
          </div>
        </div>
      )}</Show>
      <Show when={error()}><div class="ag-notice ag-notice-error ag-composer-error">{error()}</div></Show>
      <div class="ag-composer">
        <textarea
          ref={input}
          rows={2}
          value={text()}
          placeholder={permission() ? 'Resolve the permission request to continue' : chat()?.ended ? 'This agent stopped. Send to start a new chat.' : `Ask ${providerOf(chat()?.providerId ?? draftProvider())?.name ?? 'the agent'} to edit…`}
          disabled={!!permission()}
          onInput={(e) => { setText(e.currentTarget.value); grow() }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } e.stopPropagation() }}
        />
        <div class="ag-footer">
          <div class="ag-controls">
            <ModelPicker />
            <Show when={option('thought_level')}>{(o) => <><span class="ag-sep" /><OptionChip option={o()} icon="brain" /></>}</Show>
            <Show when={option('mode')}>{(o) => <OptionChip option={o()} icon="shield" />}</Show>
            <Show when={extras().length}><MoreMenu options={extras()} /></Show>
          </div>
          <Show when={busy() && !text().trim()} fallback={
            <button class="ag-send" disabled={!text().trim() || busy() || starting()} onClick={submit} data-tip="Send (Enter)">
              <Show when={starting()} fallback={<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11.5V2.5M7 2.5 3 6.5M7 2.5l4 4" /></svg>}>
                <Icon name="loader-circle" size={14} class="spin" />
              </Show>
            </button>
          }>
            <button class="ag-send ag-stop" onClick={cancel} data-tip="Stop"><span /></button>
          </Show>
        </div>
      </div>
    </div>
  )
}

const optionName = (o: SessionConfigOption) => o.type === 'select' ? flatOptions(o).find(x => x.value === o.currentValue)?.name ?? String(o.currentValue) : o.currentValue ? 'On' : 'Off'

function OptionChip(props: { option: SessionConfigOption; icon: string }) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const chat = active
  return (
    <>
      <button class="ag-chip" data-tip={props.option.name} onClick={(e) => setAnchor(anchor() ? null : e.currentTarget)}>
        <Icon name={props.icon} size={13} /><span class="ag-chip-text">{optionName(props.option)}</span>
      </button>
      <Show when={anchor()}>{(a) => (
        <Popover anchor={a()} onClose={() => setAnchor(null)} placement="top" class="ag-pop menu">
          <div class="ag-pop-head">{props.option.name}</div>
          <For each={flatOptions(props.option)}>{(o) => (
            <button class={`menu-item ag-pick ${o.value === props.option.currentValue ? 'active' : ''}`} onClick={() => { setAnchor(null); void setOption(chat()!.id, props.option.id, o.value) }}>
              <span class="ag-pick-text"><span>{o.name}</span><Show when={o.description}><small>{o.description}</small></Show></span>
              <Show when={o.value === props.option.currentValue}><Icon name="check" size={13} /></Show>
            </button>
          )}</For>
        </Popover>
      )}</Show>
    </>
  )
}

function MoreMenu(props: { options: SessionConfigOption[] }) {
  const open = (e: MouseEvent) => {
    const id = active()!.id
    openMenu(e.currentTarget as HTMLElement, props.options.flatMap((o, i) => [
      ...(i ? [{ separator: true }] : []),
      { label: o.name, disabled: true },
      ...(o.type === 'boolean'
        ? [{ label: o.currentValue ? 'On' : 'Off', checked: true, run: () => void setOption(id, o.id, !o.currentValue) }]
        : flatOptions(o).map(x => ({ label: x.name, checked: x.value === o.currentValue, run: () => void setOption(id, o.id, x.value) })))
    ]))
  }
  return <button class="ag-chip ag-more" data-tip="More options" onClick={open}><Icon name="ellipsis" size={14} /></button>
}

function ModelPicker() {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const [query, setQuery] = createSignal('')
  const [rail, setRail] = createSignal(draftProvider())
  const [loading, setLoading] = createSignal('')
  const chat = active
  const provider = () => chat()?.providerId ?? draftProvider()
  const model = () => chat()?.options.find(o => o.category === 'model')
  const label = () => (model() && optionName(model()!)) || providerOf(provider())?.name || 'Agent'
  const toggle = (e: MouseEvent) => {
    if (anchor()) return setAnchor(null)
    setRail(provider()); setQuery(''); setAnchor(e.currentTarget as HTMLElement)
    void refreshProviders()
  }
  // Models come from a live session; open one for the rail's provider when needed.
  const ensure = async (id: string) => {
    const current = active()
    if (current && current.providerId === id && !current.ended) return
    if (current?.entries.length) { chooseProvider(id); return }
    setLoading(id)
    try { await startChat(id) } catch (e) { setLoading(''); throw e }
    setLoading('')
  }
  const [failure, setFailure] = createSignal('')
  createEffect(on([anchor, rail, providers], ([a, id]) => { if (a && providerOf(id)?.available) { setFailure(''); ensure(id).catch(e => setFailure(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))) } }))
  const sameProvider = () => chat()?.providerId === rail() && !chat()?.ended
  const items = () => {
    const m = sameProvider() ? model() : undefined
    const q = query().toLowerCase()
    return m ? flatOptions(m).filter(o => !q || o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : []
  }
  return (
    <>
      <button class="ag-chip ag-model" onClick={toggle} data-tip="Agent and model">
        <Mark provider={provider()} size={14} /><span class="ag-model-name">{label()}</span><Icon name="chevron-down" size={12} class="ag-chev" />
      </button>
      <Show when={anchor()}>{(a) => (
        <Popover anchor={a()} onClose={() => setAnchor(null)} placement="top" class="ag-picker">
          <div class="ag-rail">
            <For each={providers()}>{(p) => (
              <button class={`ag-rail-btn ${rail() === p.id ? 'on' : ''} ${p.available ? '' : 'off'}`} data-tip={p.available ? p.name : `${p.name}: ${p.reason}`} onClick={() => setRail(p.id)}>
                <Mark provider={p.id} size={20} />
              </button>
            )}</For>
          </div>
          <div class="ag-picker-main">
            <div class="ag-picker-head">{providerOf(rail())?.name}</div>
            <Show when={sameProvider() && model()}>
              <label class="ag-search"><Icon name="search" size={14} /><input placeholder="Search models…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} /></label>
            </Show>
            <div class="ag-models">
              <Switch>
                <Match when={!providerOf(rail())?.available}><p class="ag-picker-note">{providerOf(rail())?.reason}</p></Match>
                <Match when={failure()}><p class="ag-picker-note error">{failure()}</p></Match>
                <Match when={chat()?.entries.length && chat()?.providerId !== rail()}>
                  <button class="menu-item ag-pick" onClick={() => { setAnchor(null); void startChat(rail()) }}>
                    <Icon name="square-pen" size={14} /><span>New chat with {providerOf(rail())?.name}</span>
                  </button>
                </Match>
                <Match when={loading() === rail() || !sameProvider()}><p class="ag-picker-note"><Icon name="loader-circle" size={13} class="spin" /> Starting {providerOf(rail())?.name}…</p></Match>
                <Match when={!model()}><p class="ag-picker-note">This agent picks its own model.</p></Match>
                <Match when={true}>
                  <For each={items()} fallback={<p class="ag-picker-note">No models found</p>}>{(o) => (
                    <button class={`menu-item ag-pick ${o.value === model()!.currentValue ? 'active' : ''}`} onClick={() => { setAnchor(null); void setOption(chat()!.id, model()!.id, o.value) }}>
                      <span class="ag-pick-text"><span>{o.name}</span><Show when={o.description}><small>{o.description}</small></Show></span>
                      <Show when={o.value === model()!.currentValue}><Icon name="check" size={13} /></Show>
                    </button>
                  )}</For>
                </Match>
              </Switch>
            </div>
          </div>
        </Popover>
      )}</Show>
    </>
  )
}

