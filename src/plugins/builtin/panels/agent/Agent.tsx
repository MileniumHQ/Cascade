import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { PanelContext } from '@core/plugin-api'
import { Icon } from '@ui/icon'
import { IconButton, openMenu, Popover, type MenuItem } from '@ui/kit'
import type { AgentAttachment, AgentUsage, KeyProvider, SessionConfigOption } from '@shared/agents'
import { markdown } from './markdown'
import { describeTool, modelParts, thoughtPreview } from './describe'
import type { AgentTools } from '../../mcp'
import {
  active, activeId, askFirst, cancel, chats, chooseProvider, closeChat, connect, draftProvider, flatOptions, newChat, providers, refreshProviders,
  dropQueued, fetchKeyProviders, fetchUsage, installProvider, setProviderKey, setEditorContext, startError, setStartError, installs, respond, status, resumeActive, send, sendQueued, setActiveId, setAskFirst, setOption, startChat, starting, type Chat, type Entry
} from './state'

// Brand marks (inline SVG keeps them crisp at 12–24px).
const MARKS: Record<string, string> = {
  claude: '<svg viewBox="0 0 24 24"><path fill="#d97757" fill-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/></svg>',
  cursor: '<svg viewBox="0 0 466.73 532.09"><path fill="#ececef" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>',
  codex: '<svg viewBox="0 0 24 24"><path fill="#ececef" fill-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>',
  opencode: '<svg viewBox="0 0 16 16"><path fill="#ececef" fill-rule="evenodd" clip-rule="evenodd" d="M13 14H3V2H13V14ZM10.5 4.4H5.5V11.6H10.5V4.4Z"/></svg>',
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
const toolLabel = (title: string) => describeTool({ title })

type WorkEntry = Extract<Entry, { kind: 'tool' | 'thought' }>
type Item = { kind: 'entry'; entry: Entry } | { kind: 'work'; entries: WorkEntry[] }
/** Runs of tool calls and thoughts between messages become one collapsible group; empty thoughts are dropped. */
function groupWork(entries: readonly Entry[]): Item[] {
  const items: Item[] = []
  for (const entry of entries) {
    if (entry.kind === 'thought' && !entry.text.trim()) continue
    if (entry.kind !== 'tool' && entry.kind !== 'thought') { items.push({ kind: 'entry', entry }); continue }
    const last = items.at(-1)
    if (last?.kind === 'work') last.entries.push(entry)
    else items.push({ kind: 'work', entries: [entry] })
  }
  return items
}

export function AgentPanel(props: { ctx: PanelContext }) {
  connect(props.ctx.app.host?.agents)
  setEditorContext(() => (props.ctx.app.services.get('agent-tools') as AgentTools | undefined)?.editorState() ?? '')
  return (
    <div class="ag">
      <Show when={props.ctx.app.host?.agents} fallback={<div class="ag-empty"><p>Agents are only available in the desktop app.</p></div>}>
        <JobBar app={props.ctx.app} />
        <Thread />
        <Composer />
      </Show>
    </div>
  )
}

/** Progress of a long agent job (captions, analysis, audio check, export), pinned above the thread. */
function JobBar(props: { app: PanelContext['app'] }) {
  const [job, setJob] = createSignal<ReturnType<AgentTools['activeJob']>>()
  const timer = setInterval(() => setJob((props.app.services.get('agent-tools') as AgentTools | undefined)?.activeJob()), 300)
  onCleanup(() => clearInterval(timer))
  return (
    <Show when={job()}>{(j) => (
      <div class="ag-job" title={j().message}>
        <div class="ag-job-text"><span class="ag-job-label">{j().label}</span><span class="ag-job-message">{j().message}</span>
          <Show when={j().progress !== undefined}><span class="ag-job-pct">{Math.round(j().progress! * 100)}%</span></Show></div>
        <div class={`ag-job-track${j().progress === undefined ? ' ag-job-indeterminate' : ''}`}><div class="ag-job-fill" style={{ width: j().progress === undefined ? undefined : `${j().progress! * 100}%` }} /></div>
      </div>
    )}</Show>
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
  const items = createMemo(() => groupWork(chat()?.entries ?? []))
  createEffect(on(activeId, () => { pinned = true; queueMicrotask(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight }) }))
  return (
    <div class="ag-thread" ref={scroller} onScroll={onScroll}>
      <Show when={chat()?.entries.length} fallback={<Hero />}>
        <Index each={items()}>{(item, i) => (
          <Show when={item().kind === 'work' && item() as Extract<Item, { kind: 'work' }>} fallback={<Row entry={(item() as Extract<Item, { kind: 'entry' }>).entry} />}>
            {(w) => <WorkGroup entries={w().entries} live={!!chat()?.running && i === items().length - 1} />}
          </Show>
        )}</Index>
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
      <Match when={props.entry.kind === 'user' && props.entry}>{(e) => (
        <div class="ag-user">
          <div class="ag-bubble">
            <Show when={e().attachments?.length}>
              <div class="ag-atts">
                <For each={e().attachments}>{(a) => a.src
                  ? <img class="ag-thumb" src={a.src} alt={a.name} title={a.name} />
                  : <span class="ag-file"><Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} />{a.name}</span>}</For>
              </div>
            </Show>
            <Show when={e().text}>{e().text}</Show>
          </div>
        </div>
      )}</Match>
      <Match when={props.entry.kind === 'assistant' && props.entry}>{(e) => <div class="ag-assistant ag-md" innerHTML={markdown(e().text)} />}</Match>
      <Match when={props.entry.kind === 'thought' && props.entry}>{(e) => (
        <div class="ag-work">
          <button class="ag-work-row" onClick={() => setOpen(!open())} aria-expanded={open()}>
            <Icon name="brain" size={14} class="ag-work-icon" /><span class="ag-work-label ag-thought">{thoughtPreview(e().text) || 'Thought'}</span>
            <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={12} class="ag-chev" />
          </button>
          <Show when={open()}><div class="ag-work-detail ag-md" innerHTML={markdown(e().text)} /></Show>
        </div>
      )}</Match>
      <Match when={props.entry.kind === 'tool' && props.entry}>{(e) => {
        const label = createMemo(() => e().label ?? toolLabel(e().title))
        return (
          <div class={`ag-work ag-${e().status}`}>
            <button class="ag-work-row" onClick={() => setOpen(!open())} aria-expanded={open()} disabled={!e().detail}>
              <Icon name={label().cascade ? 'clapperboard' : TOOL_ICONS[e().toolKind] ?? 'wrench'} size={14} class="ag-work-icon" />
              <span class={`ag-work-label ${label().mono ? 'ag-mono' : ''}`}>{label().label}</span>
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

/** A run of tool calls / thoughts. Short runs show inline; longer ones collapse to a summary (the live one shows its latest step). */
function WorkGroup(props: { entries: WorkEntry[]; live: boolean }) {
  const [open, setOpen] = createSignal(false)
  const count = (kind: WorkEntry['kind']) => props.entries.filter(e => e.kind === kind).length
  const failed = () => props.entries.filter(e => e.kind === 'tool' && e.status === 'failed').length
  const summary = () => {
    const tools = count('tool'), thoughts = count('thought')
    return [tools && `${tools} ${tools === 1 ? 'step' : 'steps'}`, thoughts && `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}`, failed() && `${failed()} failed`].filter(Boolean).join(' · ')
  }
  const cascade = () => props.entries.some(e => e.kind === 'tool' && (e.label ?? toolLabel(e.title)).cascade)
  return (
    <Show when={props.entries.length > 2} fallback={<For each={props.entries}>{(e) => <Row entry={e} />}</For>}>
      <div class={`ag-group ${open() ? 'open' : ''}`}>
        <button class={`ag-work-row ag-group-head ${props.live ? 'ag-in_progress' : ''}`} onClick={() => setOpen(!open())} aria-expanded={open()}>
          <Icon name={cascade() ? 'clapperboard' : 'list-tree'} size={14} class="ag-work-icon" />
          <span class="ag-work-label">{props.live ? 'Working' : 'Worked'} · {summary()}</span>
          <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={12} class="ag-chev" />
        </button>
        <Show when={open()} fallback={<Show when={props.live}><div class="ag-group-body"><Row entry={props.entries[props.entries.length - 1]} /></div></Show>}>
          <div class="ag-group-body"><For each={props.entries}>{(e) => <Row entry={e} />}</For></div>
        </Show>
      </div>
    </Show>
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
  const [atts, setAtts] = createSignal<AgentAttachment[]>([])
  let input!: HTMLTextAreaElement
  let picker!: HTMLInputElement
  const chat = active
  const busy = () => !!chat()?.running
  const permission = () => chat()?.permissions[0]
  const ready = () => !!text().trim() || atts().length > 0
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px` }
  const submit = () => {
    if (!ready() || starting()) return
    const value = text().trim(), attachments = atts()
    setText(''); setAtts([]); setError(''); queueMicrotask(grow)
    send(value, attachments).catch(e => setError(String(e?.message ?? e)))
  }
  const attach = async (files: Iterable<File>) => {
    for (const file of files) {
      const path = window.cascade?.fs.pathForFile(file) || ''
      if (file.type.startsWith('image/') && file.size <= 8 * 1024 * 1024) {
        const data = await new Promise<string>((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(',')[1] ?? ''); r.onerror = () => fail(r.error); r.readAsDataURL(file) })
        setAtts(a => [...a, { kind: 'image', name: file.name || 'pasted image', mimeType: file.type, data }])
      } else if (path) setAtts(a => [...a, { kind: 'file', name: file.name, path }])
      else setError(`Can't attach ${file.name || 'that'}: images up to 8 MB, or files from disk.`)
    }
    input.focus()
  }
  const option = (category: string) => chat()?.options.find(o => o.category === category)
  const extras = () => chat()?.options.filter(o => !['model', 'thought_level', 'mode'].includes(o.category ?? '')) ?? []
  createEffect(on(activeId, () => input?.focus()))
  return (
    <div class="ag-composer-wrap">
      <Show when={chat()?.queue.length}>
        <div class="ag-queue">
          <div class="ag-queue-head"><Icon name="list-ordered" size={12} />{chat()!.paused ? 'Queued (paused after stop)' : 'Queued, sends when the agent finishes'}</div>
          <For each={chat()!.queue}>{(q) => (
            <div class="ag-queue-item">
              <span class="ag-queue-text">{q.text || q.attachments.map(a => a.name).join(', ')}</span>
              <Show when={!busy()}><IconButton size="sm" icon="arrow-up" tip="Send now" onClick={() => void sendQueued(q.id)} /></Show>
              <IconButton size="sm" icon="x" tip="Remove" onClick={() => dropQueued(q.id)} />
            </div>
          )}</For>
        </div>
      </Show>
      <Show when={permission()}>{(p) => (
        <div class="ag-approval">
          <div class="ag-approval-head"><Icon name="shield-alert" size={13} /><span>Permission needed</span>
            <Show when={chat()!.permissions.length > 1}><span class="ag-count">1/{chat()!.permissions.length}</span></Show></div>
          <div class="ag-approval-title">{describeTool(p().toolCall).label}</div>
          <Show when={p().toolCall.rawInput}><pre class="ag-approval-detail">{(() => { const i = p().toolCall.rawInput as Record<string, unknown>; return typeof i?.command === 'string' ? i.command : JSON.stringify(i, null, 1) })()}</pre></Show>
          <div class="ag-approval-actions">
            <For each={p().options}>{(o) => (
              <button class={`ag-pill ${o.kind.startsWith('allow') ? (o.kind === 'allow_once' ? 'primary' : '') : 'outline'}`} onClick={() => respond(p().requestId, o.optionId)}>{o.name}</button>
            )}</For>
          </div>
        </div>
      )}</Show>
      <Show when={error() || startError()}>
        <div class="ag-notice ag-notice-error ag-composer-error ag-dismiss">
          <span>{linkify(error() || startError())}</span>
          <IconButton size="sm" icon="x" tip="Dismiss" onClick={() => { setError(''); setStartError('') }} />
        </div>
      </Show>
      <Show when={status()}><div class="ag-notice ag-composer-error"><Icon name="log-in" size={12} /> {status()}</div></Show>
      <div class="ag-composer"
        onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation() } }}
        onDrop={(e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); e.stopPropagation(); void attach(e.dataTransfer.files) } }}>
        <Show when={atts().length}>
          <div class="ag-atts ag-atts-draft">
            <For each={atts()}>{(a, i) => (
              <span class="ag-att">
                <Show when={a.kind === 'image' && a} fallback={<span class="ag-file"><Icon name="file" size={12} />{a.name}</span>}>
                  {(img) => <img class="ag-thumb" src={`data:${img().mimeType};base64,${img().data}`} alt={a.name} title={a.name} />}
                </Show>
                <button class="ag-att-x" data-tip="Remove" onClick={() => setAtts(list => list.filter((_, j) => j !== i()))}><Icon name="x" size={10} /></button>
              </span>
            )}</For>
          </div>
        </Show>
        <textarea
          ref={input}
          rows={2}
          value={text()}
          placeholder={permission() ? 'Resolve the permission request to continue' : busy() ? 'Queue a follow-up…' : chat()?.ended ? 'Send to resume this chat' : `Ask ${providerOf(chat()?.providerId ?? draftProvider())?.name ?? 'the agent'} to edit…`}
          disabled={!!permission()}
          onInput={(e) => { setText(e.currentTarget.value); grow() }}
          onPaste={(e) => { const files = [...(e.clipboardData?.files ?? [])]; if (files.length) { e.preventDefault(); void attach(files) } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } e.stopPropagation() }}
        />
        <div class="ag-footer">
          <div class="ag-controls">
            <input ref={picker} type="file" multiple hidden onChange={(e) => { void attach([...(e.currentTarget.files ?? [])]); e.currentTarget.value = '' }} />
            <button class="ag-chip ag-attach" data-tip="Attach images or files (or paste / drop)" onClick={() => picker.click()}><Icon name="paperclip" size={13} /></button>
            <ModelPicker />
            <Show when={option('thought_level')}>{(o) => <><span class="ag-sep" /><OptionChip option={o()} icon="brain" /></>}</Show>
            <Show when={option('mode')}>{(o) => <OptionChip option={o()} icon="shield" />}</Show>
            <UsageButton />
            <MoreMenu options={extras()} />
          </div>
          <Show when={busy() && !ready()} fallback={
            <button class="ag-send" disabled={!ready() || starting()} onClick={submit} data-tip={busy() ? 'Queue (Enter)' : 'Send (Enter)'}>
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

/** Plain text with clickable http(s) links (login URLs in start-up errors). */
const linkify = (text: string) => text.split(/(https?:\/\/\S+)/).map((part, i) => i % 2 ? <a href={part} target="_blank" rel="noreferrer">{part.length > 60 ? `${part.slice(0, 57)}…` : part}</a> : part)

const optionName = (o: SessionConfigOption) => o.type === 'select' ? flatOptions(o).find(x => x.value === o.currentValue)?.name ?? String(o.currentValue) : o.currentValue ? 'On' : 'Off'
/** Model chip: just the model ("google-vertex/Claude Opus 5.5" → "Claude Opus 5.5"). */
const modelName = (o: SessionConfigOption) => modelParts(optionName(o)).name

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
    const id = active()?.id ?? ''
    const items: MenuItem[] = props.options.flatMap<MenuItem>(o => [
      { separator: true },
      { label: o.name, disabled: true },
      ...(o.type === 'boolean'
        ? [{ label: o.currentValue ? 'On' : 'Off', checked: true, run: () => void setOption(id, o.id, !o.currentValue) }]
        : flatOptions(o).map(x => ({ label: x.name, checked: x.value === o.currentValue, run: () => void setOption(id, o.id, x.value) })))
    ])
    items.unshift({ label: 'Ask before actions', icon: 'shield-check', checked: askFirst(), run: () => setAskFirst(!askFirst()) })
    openMenu(e.currentTarget as HTMLElement, items)
  }
  return <button class="ag-chip ag-more" data-tip="More options" onClick={open}><Icon name="ellipsis" size={14} /></button>
}

const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

/** Plan limits for the chat's agent (Claude/Codex/Cursor) or token use (OpenCode), plus this chat's context fill. */
function UsageButton() {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const [usage, setUsage] = createSignal<AgentUsage | null>(null)
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const chat = active
  const provider = () => chat()?.providerId ?? draftProvider()
  const load = (fresh = false) => {
    const id = provider()
    setLoading(true); setError('')
    fetchUsage(id, fresh)
      .then(u => { if (provider() === id) setUsage(u) })
      .catch(e => { if (provider() === id) { setUsage(null); setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } })
      .finally(() => setLoading(false))
  }
  const toggle = (e: MouseEvent) => {
    if (anchor()) return setAnchor(null)
    setUsage(null); setAnchor(e.currentTarget as HTMLElement); load()
  }
  const context = () => {
    const u = chat()?.usage
    if (!u?.size) return ''
    const cost = u.cost !== undefined ? ` · ${u.currency === 'USD' || !u.currency ? '$' : `${u.currency} `}${u.cost.toFixed(2)}` : ''
    return `${tokens(u.used)} / ${tokens(u.size)} context${cost}`
  }
  return (
    <>
      <button class="ag-chip ag-more" data-tip="Usage" disabled={!providerOf(provider())?.available} onClick={toggle}><Icon name="gauge" size={14} /></button>
      <Show when={anchor()}>{(a) => (
        <Popover anchor={a()} onClose={() => setAnchor(null)} placement="top" class="ag-pop ag-usage">
          <div class="ag-usage-head">
            <span>{providerOf(provider())?.name} usage</span>
            <IconButton size="sm" icon="refresh-cw" tip="Refresh" onClick={() => load(true)} />
          </div>
          <Switch>
            <Match when={loading() && !usage()}><p class="ag-picker-note"><Icon name="loader-circle" size={13} class="spin" /> Checking…</p></Match>
            <Match when={error()}><p class="ag-picker-note error">{error()}</p></Match>
            <Match when={usage()}>{(u) => (
              <>
                <For each={u().meters}>{(m) => (
                  <div class="ag-meter">
                    <div class="ag-meter-row"><span>{m.label}</span><span class="ag-meter-pct">{Math.round(m.percent)}%</span></div>
                    <div class={`ag-meter-bar ${m.percent >= 90 ? 'hot' : ''}`}><span style={{ width: `${m.percent}%` }} /></div>
                    <Show when={m.resets}><small>Resets {m.resets}</small></Show>
                  </div>
                )}</For>
                <Show when={u().stats.length}>
                  <div class="ag-stats">
                    <For each={u().stats}>{(st) => <div class={`ag-stat ${st.sub ? 'sub' : ''}`}><span>{st.label}</span><span>{st.value}</span></div>}</For>
                  </div>
                </Show>
                <Show when={u().note}><p class="ag-usage-note">{u().note}</p></Show>
              </>
            )}</Match>
          </Switch>
          <Show when={context()}><div class="ag-stats ag-usage-chat"><div class="ag-stat"><span>This chat</span><span>{context()}</span></div></div></Show>
        </Popover>
      )}</Show>
    </>
  )
}

function ModelPicker() {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const [query, setQuery] = createSignal('')
  const [rail, setRail] = createSignal(draftProvider())
  const [loading, setLoading] = createSignal('')
  // OpenCode only: the /connect view (model provider + API key) instead of the model list.
  const [keys, setKeys] = createSignal(false)
  const chat = active
  const provider = () => chat()?.providerId ?? draftProvider()
  const model = () => chat()?.options.find(o => o.category === 'model')
  const label = () => (model() && modelName(model()!)) || providerOf(provider())?.name || 'Agent'
  const toggle = (e: MouseEvent) => {
    if (anchor()) return setAnchor(null)
    setRail(provider()); setQuery(''); setKeys(false); setAnchor(e.currentTarget as HTMLElement)
    void refreshProviders()
  }
  // Models come from a live session; open one for the rail's provider when needed.
  const ensure = async (id: string) => {
    const current = active()
    if (current && current.providerId === id && !current.ended) return
    if (current?.ended && current.providerId === id && current.entries.length) {
      setLoading(id)
      try { await resumeActive() } finally { setLoading('') }
      return
    }
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
    return m ? flatOptions(m).map(o => ({ ...o, ...modelParts(o.name) })).filter(o => !q || o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.provider?.toLowerCase().includes(q)) : []
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
              <button class={`ag-rail-btn ${rail() === p.id ? 'on' : ''} ${p.available ? '' : 'off'}`} data-tip={p.available ? p.name : `${p.name}: ${p.reason}`} onClick={() => { setRail(p.id); setKeys(false) }}>
                <Mark provider={p.id} size={20} />
              </button>
            )}</For>
          </div>
          <div class="ag-picker-main">
            <div class="ag-picker-head">
              <span>{providerOf(rail())?.name}</span>
              <Show when={rail() === 'opencode' && providerOf(rail())?.available}>
                <button class={`ag-head-btn ${keys() ? 'on' : ''}`} onClick={() => setKeys(!keys())}><Icon name="key" size={13} /><span>Connect provider</span></button>
              </Show>
            </div>
            <Show when={keys()}><KeyConnect agent={rail()} onSaved={() => setKeys(false)} /></Show>
            <Show when={!keys() && sameProvider() && model()}>
              <label class="ag-search"><Icon name="search" size={14} /><input placeholder="Search models…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} /></label>
            </Show>
            <div class="ag-models" hidden={keys()}>
              <Switch>
                <Match when={!providerOf(rail())?.available}>
                  <p class="ag-picker-note">{providerOf(rail())?.reason}</p>
                  <Show when={providerOf(rail())?.install}>
                    <Show when={installs[rail()] && !installs[rail()]!.error} fallback={
                      <>
                        <Show when={installs[rail()]?.error}><p class="ag-picker-note error">{installs[rail()]!.error}</p></Show>
                        <button class="menu-item ag-pick" onClick={() => void installProvider(rail())}>
                          <Icon name="download" size={14} /><span class="ag-pick-text"><span>Install {providerOf(rail())?.name}</span><small>Official build from the ACP registry, kept in Cascade’s data folder</small></span>
                        </button>
                      </>
                    }>
                      {(() => {
                        const p = () => installs[rail()]!
                        return (
                          <div class="ag-install">
                            <div class="ag-install-bar"><span style={{ width: `${p().total ? Math.round(p().received / p().total * 100) : 3}%` }} /></div>
                            <small>{p().received && p().received === p().total ? 'Unpacking…' : `Downloading ${Math.round(p().received / 1e6)}${p().total ? ` / ${Math.round(p().total / 1e6)}` : ''} MB`}</small>
                          </div>
                        )
                      })()}
                    </Show>
                  </Show>
                </Match>
                <Match when={failure()}><p class="ag-picker-note error">{failure()}</p></Match>
                <Match when={chat()?.entries.length && chat()?.providerId !== rail()}>
                  <button class="menu-item ag-pick" onClick={() => { setAnchor(null); startChat(rail()).catch(() => {}) }}>
                    <Icon name="square-pen" size={14} /><span>New chat with {providerOf(rail())?.name}</span>
                  </button>
                </Match>
                <Match when={loading() === rail() || !sameProvider()}><p class="ag-picker-note"><Icon name="loader-circle" size={13} class="spin" /> {status() || `Starting ${providerOf(rail())?.name}…`}</p></Match>
                <Match when={!model()}><p class="ag-picker-note">This agent picks its own model.</p></Match>
                <Match when={true}>
                  <For each={items()} fallback={<p class="ag-picker-note">No models found</p>}>{(o) => (
                    <button class={`menu-item ag-pick ${o.value === model()!.currentValue ? 'active' : ''}`} onClick={() => { setAnchor(null); void setOption(chat()!.id, model()!.id, o.value) }}>
                      <span class="ag-pick-text"><span>{o.name}</span><Show when={o.provider || o.description}><small>{[o.provider, o.description].filter(Boolean).join(' · ')}</small></Show></span>
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


const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** OpenCode's /connect: pick a model provider, paste its API key. */
function KeyConnect(props: { agent: string; onSaved: () => void }) {
  const [list, setList] = createSignal<KeyProvider[] | null>(null)
  const [query, setQuery] = createSignal('')
  const [picked, setPicked] = createSignal<KeyProvider | null>(null)
  const [key, setKey] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const load = () => fetchKeyProviders(props.agent).then(setList).catch(e => { setList([]); setError(errorText(e)) })
  onMount(() => void load())
  const shown = () => {
    const q = query().toLowerCase()
    return (list() ?? []).filter(p => !q || p.name.toLowerCase().includes(q) || p.id.includes(q))
  }
  const pick = (p: KeyProvider) => { setPicked(p); setKey(''); setError('') }
  const apply = async (value: string | null) => {
    const p = picked()
    if (!p || busy() || (value !== null && !value.trim())) return
    setBusy(true); setError('')
    try { await setProviderKey(props.agent, p.id, value); if (value !== null) return props.onSaved(); setPicked(null); await load() }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  return (
    <Show when={picked()} fallback={
      <>
        <label class="ag-search"><Icon name="search" size={14} /><input placeholder="Search providers…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} /></label>
        <div class="ag-models">
          <Show when={error()}><p class="ag-picker-note error">{error()}</p></Show>
          <Show when={list()} fallback={<p class="ag-picker-note"><Icon name="loader-circle" size={13} class="spin" /> Loading providers…</p>}>
            <For each={shown()} fallback={<p class="ag-picker-note">No providers found</p>}>{(p) => (
              <button class="menu-item ag-pick" onClick={() => pick(p)}>
                <span class="ag-pick-text"><span>{p.name}</span><Show when={p.connected}><small>Connected</small></Show></span>
                <Show when={p.connected}><Icon name="check" size={13} /></Show>
              </button>
            )}</For>
          </Show>
        </div>
      </>
    }>{(p) => (
      <form class="ag-key" onSubmit={(e) => { e.preventDefault(); void apply(key()) }}>
        <button type="button" class="ag-key-back" onClick={() => setPicked(null)}><Icon name="chevron-left" size={13} />{p().name}</button>
        <input class="ag-key-input" type="password" placeholder={p().connected ? 'Paste a new API key to replace the saved one' : 'Paste API key'} autofocus spellcheck={false} value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
        <Show when={error()}><p class="ag-picker-note error">{error()}</p></Show>
        <div class="ag-key-actions">
          <Show when={p().connected}><button type="button" class="btn btn-sm" disabled={busy()} onClick={() => void apply(null)}><Icon name="trash-2" size={13} />Remove</button></Show>
          <button type="submit" class="btn btn-sm btn-primary" disabled={busy() || !key().trim()}>{busy() ? 'Saving…' : 'Save key'}</button>
        </div>
        <small class="ag-key-note">Stored by OpenCode on this computer, like its /connect command.</small>
      </form>
    )}</Show>
  )
}
