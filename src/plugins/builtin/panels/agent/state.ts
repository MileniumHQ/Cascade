import { createStore, produce, unwrap } from 'solid-js/store'
import { createSignal } from 'solid-js'
import type { AgentAttachment, AgentEvent, AgentProvider, AgentSession, AgentsBridge, PermissionOption, SessionConfigOption, SessionUpdate, ToolCallUpdate } from '@shared/agents'

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
export type Entry =
  | { kind: 'user'; text: string; attachments?: Shown[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind: string; status: ToolStatus; detail: string }
  | { kind: 'plan'; items: { content: string; status: string }[] }
  | { kind: 'notice'; text: string; tone: 'info' | 'error' }

/** How an attachment is shown in the thread (image data is kept in memory only, not persisted). */
export interface Shown { kind: 'image' | 'file'; name: string; src?: string }
export interface Queued { id: number; text: string; attachments: AgentAttachment[] }
export interface Permission { requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
export interface Chat {
  id: string
  providerId: string
  agent: string
  title: string
  entries: Entry[]
  options: SessionConfigOption[]
  running: boolean
  startedAt: number
  permissions: Permission[]
  cascadeTools: boolean
  ended: boolean
  /** Agent's session id + cwd, for resuming after the agent exits or the app restarts. */
  sessionId: string
  cwd: string
  images: boolean
  /** Messages typed while the agent was working; sent in order when it finishes. */
  queue: Queued[]
  /** The queue stops after a manual Stop until the user sends again. */
  paused: boolean
  /** A fresh session replacing one that couldn't be reloaded; adopted (with its notice) on the next message,
   *  so merely opening the chat never overwrites a reloadable session id with an empty one. */
  fresh?: { sessionId: string; notice: string }
}

const STORE = 'cascade.agent.chats'
const restore = (): Chat[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Chat[]
    return saved.map(c => ({ ...c, running: false, permissions: [], queue: [], paused: false, ended: true, fresh: undefined }))
  } catch { return [] }
}
const [chats, setChats] = createStore<Chat[]>(restore())
const [activeId, setActiveId] = createSignal<string | null>(localStorage.getItem(`${STORE}.active`))
if (!chats.some(c => c.id === activeId())) setActiveId(null)

/** Save the last 30 chats (trimmed) shortly after changes. */
let saveTimer: ReturnType<typeof setTimeout> | undefined
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 600)
}
function flush() {
  clearTimeout(saveTimer)
  const trimmed = chats.filter(c => c.entries.length).slice(-30).map(c => ({
    ...c, running: false, permissions: [], queue: [],
    entries: c.entries.slice(-300).map(e =>
      e.kind === 'tool' ? { ...e, detail: e.detail.slice(0, 1500) }
        : e.kind === 'user' && e.attachments ? { ...e, attachments: e.attachments.map(a => ({ kind: a.kind, name: a.name })) }
          : e)
  }))
  try {
    localStorage.setItem(STORE, JSON.stringify(trimmed))
    localStorage.setItem(`${STORE}.active`, activeId() ?? '')
  } catch { /* Quota: keep the in-memory history. */ }
}
addEventListener('pagehide', flush)
addEventListener('beforeunload', flush)
const [providers, setProviders] = createSignal<AgentProvider[]>([])
/** Provider chosen for the next chat, before any session exists. */
const [draftProvider, setDraftProvider] = createSignal(localStorage.getItem('cascade.agent.provider') ?? 'claude')
const [starting, setStarting] = createSignal(false)
/** Off by default: permission requests are answered with the agent's allow option. Edits are undoable in Cascade. */
const [askFirst, setAskFirstSignal] = createSignal(localStorage.getItem('cascade.agent.askFirst') === '1')
/** Last failure starting an agent (shown above the composer; the picker may have closed). */
const [startError, setStartError] = createSignal('')
export { startError, setStartError }
/** Start-up message from the host (e.g. waiting for browser sign-in). */
const [status, setStatus] = createSignal('')
/** Download progress per provider while installing from the ACP registry. */
const [installs, setInstalls] = createStore<Record<string, { received: number; total: number; error?: string } | undefined>>({})
export { chats, activeId, setActiveId, providers, draftProvider, starting, askFirst, status, installs }

export async function installProvider(id: string) {
  if (!bridge || installs[id] && !installs[id]!.error) return
  setInstalls(id, { received: 0, total: 0 })
  try {
    await bridge.install(id)
    setInstalls(id, undefined)
    await refreshProviders()
  } catch (error) { setInstalls(id, { received: 0, total: 0, error: message(error) }) }
}
export function setAskFirst(on: boolean) {
  setAskFirstSignal(on)
  localStorage.setItem('cascade.agent.askFirst', on ? '1' : '0')
}

export const active = () => chats.find(c => c.id === activeId()) ?? null
const index = (id: string) => chats.findIndex(c => c.id === id)
const edit = (id: string, fn: (chat: Chat) => void) => { const i = index(id); if (i >= 0) { setChats(i, produce(fn)); save() } }

/** Remembered option values per provider (model, effort, mode…), re-applied to new chats. */
const remembered = (providerId: string): Record<string, string | boolean> => {
  try { return JSON.parse(localStorage.getItem(`cascade.agent.options.${providerId}`) ?? '{}') } catch { return {} }
}
const remember = (providerId: string, configId: string, value: string | boolean) =>
  localStorage.setItem(`cascade.agent.options.${providerId}`, JSON.stringify({ ...remembered(providerId), [configId]: value }))

let bridge: AgentsBridge | null = null
let unlisten: (() => void) | null = null
export function connect(host: AgentsBridge | undefined) {
  if (!host || bridge === host) return
  bridge = host
  unlisten?.()
  unlisten = host.onEvent(onEvent)
  void refreshProviders()
}
export async function refreshProviders() { if (bridge) setProviders(await bridge.providers()) }

export function chooseProvider(id: string) {
  setDraftProvider(id)
  localStorage.setItem('cascade.agent.provider', id)
}

/** Start a chat for a provider. An unused (empty) chat of another provider is replaced. */
export async function startChat(providerId = draftProvider()): Promise<Chat | null> {
  if (!bridge) throw new Error('Agents are only available in the desktop app')
  chooseProvider(providerId)
  const previous = active()
  if (previous && !previous.entries.length && previous.providerId === providerId && !previous.ended) return previous
  setStarting(true)
  setStartError('')
  try {
    const session = await bridge.start(providerId).catch((error: unknown) => { setStartError(message(error)); throw error })
    const chat: Chat = { id: session.id, providerId, agent: session.agent, title: 'New chat', entries: [], options: session.options, running: false, startedAt: 0, permissions: [], cascadeTools: session.cascadeTools, ended: false, sessionId: session.sessionId, cwd: session.cwd, images: session.images, queue: [], paused: false }
    if (previous && !previous.entries.length) closeChat(previous.id)
    setChats(chats.length, chat)
    setActiveId(chat.id)
    save()
    if (!session.cascadeTools) edit(chat.id, c => { c.entries.push({ kind: 'notice', tone: 'info', text: 'This agent could not attach Cascade’s editor tools, so it can chat but not edit the project.' }) })
    // Re-apply the user's last choices for this agent when they're still offered.
    await applyRemembered(chat.id, providerId, chat.options)
    return active()
  } finally { setStarting(false); setStatus('') }
}

async function applyRemembered(chatId: string, providerId: string, options: SessionConfigOption[]) {
  for (const [configId, value] of Object.entries(remembered(providerId))) {
    const option = options.find(o => o.id === configId)
    if (!option || option.currentValue === value) continue
    if (option.type === 'select' && !flatOptions(option).some(o => o.value === value)) continue
    await setOption(chatId, configId, value, false).catch(() => {})
  }
}

/** Bring an ended chat (agent exited, or restored after restart) back: reload its session when the agent can. */
async function resumeChat(chat: Chat): Promise<string | null> {
  if (!bridge) return null
  setStarting(true)
  try {
    let session: AgentSession
    try { session = await bridge.start(chat.providerId, { resume: chat.sessionId || undefined, cwd: chat.cwd || undefined }) }
    catch (error) { setStartError(message(error)); return null }
    const old = chat.id
    edit(old, c => {
      c.id = session.id; c.ended = false; c.cwd = session.cwd; c.images = session.images
      c.options = session.options; c.agent = session.agent; c.cascadeTools = session.cascadeTools
      if (session.resumed) { c.sessionId = session.sessionId; c.fresh = undefined }
      else c.fresh = { sessionId: session.sessionId, notice: `Started a fresh session; the agent doesn’t remember the messages above${session.resumeError ? ` (${session.resumeError})` : ''}.` }
    })
    if (activeId() === old) setActiveId(session.id)
    if (!session.resumed) await applyRemembered(session.id, chat.providerId, session.options)
    return session.id
  } finally { setStarting(false); setStatus('') }
}

/** Resume the active chat if its agent has stopped (used by the picker to list models). */
export async function resumeActive() { const c = active(); if (c?.ended && c.entries.length) await resumeChat(c) }

export function newChat() {
  const current = active()
  if (current && !current.entries.length) return
  setActiveId(null)
}

export function closeChat(id: string) {
  void bridge?.close(id)
  const i = index(id)
  if (i >= 0) setChats(produce(list => { list.splice(i, 1) }))
  if (activeId() === id) setActiveId(chats.at(-1)?.id ?? null)
  save()
}

let queueId = 0
/** Send now, or queue it when the agent is busy. */
export async function send(text: string, attachments: AgentAttachment[] = []) {
  let chat = active()
  if (chat?.running) {
    edit(chat.id, c => { c.queue.push({ id: ++queueId, text, attachments }); c.paused = false })
    return
  }
  if (chat?.ended && chat.entries.length) {
    const id = await resumeChat(chat)
    chat = id ? chats[index(id)] : null
  } else if (!chat || chat.ended) chat = await startChat()
  if (!chat || !bridge) return
  await turn(chat.id, text, attachments)
}

const shown = (a: AgentAttachment): Shown => a.kind === 'image' ? { kind: 'image', name: a.name, src: `data:${a.mimeType};base64,${a.data}` } : { kind: 'file', name: a.name }

async function turn(startId: string, text: string, attachments: AgentAttachment[]) {
  if (!bridge) return
  let id = startId
  edit(id, c => {
    if (c.fresh) { c.sessionId = c.fresh.sessionId; c.entries.push({ kind: 'notice', tone: 'info', text: c.fresh.notice }); c.fresh = undefined }
    c.entries.push({ kind: 'user', text, ...(attachments.length ? { attachments: attachments.map(shown) } : {}) })
    if (c.title === 'New chat') c.title = (text || attachments[0]?.name || 'Chat').replace(/\s+/g, ' ').slice(0, 60)
    c.running = true; c.startedAt = Date.now()
  })
  let next: Queued | undefined
  try {
    // Queued items come out of the store as proxies, which IPC can't clone.
    const stop = await bridge.prompt(id, text, structuredClone(unwrap(attachments)))
    if (stop === 'refusal') edit(id, c => { c.entries.push({ kind: 'notice', tone: 'error', text: 'The agent declined this request.' }) })
    if (stop === 'max_tokens' || stop === 'max_turn_requests') edit(id, c => { c.entries.push({ kind: 'notice', tone: 'info', text: 'The agent stopped early (turn limit). Say “continue” to resume.' }) })
    if (stop === 'cancelled') edit(id, c => { if (c.queue.length) c.paused = true })
  } catch (error) {
    edit(id, c => { c.entries.push({ kind: 'notice', tone: 'error', text: message(error) }); if (c.queue.length) c.paused = true })
  } finally {
    edit(id, c => {
      c.running = false; c.permissions = []
      if (!c.paused && !c.ended) next = c.queue.shift()
    })
  }
  const chat = chats[index(id)]
  if (next && chat) { id = chat.id; await turn(id, next.text, next.attachments) }
}

/** Queue controls: send a queued message now (when idle) or drop it. */
export async function sendQueued(itemId: number) {
  const chat = active()
  const item = chat?.queue.find(q => q.id === itemId)
  if (!chat || !item || chat.running) return
  edit(chat.id, c => { c.queue = c.queue.filter(q => q.id !== itemId); c.paused = false })
  await send(item.text, item.attachments)
}
export const dropQueued = (itemId: number) => { const c = active(); if (c) edit(c.id, x => { x.queue = x.queue.filter(q => q.id !== itemId) }) }

export const cancel = () => { const c = active(); if (c && bridge) void bridge.cancel(c.id).catch(() => {}) }
export const respond = (requestId: string, optionId: string | null) => {
  const c = active()
  if (c && bridge) void bridge.respond(c.id, requestId, optionId)
}

export async function setOption(chatId: string, configId: string, value: string | boolean, persist = true) {
  if (!bridge) return
  const chat = chats[index(chatId)]
  if (persist && chat) remember(chat.providerId, configId, value)
  const options = await bridge.setOption(chatId, configId, value)
  edit(chatId, c => { c.options = options })
}

export const flatOptions = (option: SessionConfigOption) =>
  option.type === 'select' ? option.options.flatMap(o => 'options' in o ? o.options : [o]) : []

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const text = (content: unknown): string => {
  const c = content as { type?: string; text?: string; uri?: string; resource?: { text?: string; uri?: string } }
  if (c?.type === 'text') return c.text ?? ''
  if (c?.type === 'resource_link') return c.uri ?? ''
  if (c?.type === 'resource') return c.resource?.text ?? c.resource?.uri ?? ''
  if (c?.type === 'image') return '[image]'
  return ''
}
function toolDetail(update: ToolCallUpdate): string {
  const parts: string[] = []
  const input = update.rawInput as Record<string, unknown> | undefined
  if (input && typeof input === 'object') {
    const command = input.command ?? input.cmd
    parts.push(typeof command === 'string' ? `$ ${command}` : JSON.stringify(input, null, 1).slice(0, 1200))
  }
  for (const c of update.content ?? []) {
    if (c.type === 'content') parts.push(text(c.content))
    else if (c.type === 'diff') parts.push(`${c.path}\n${c.newText.slice(0, 1500)}`)
    else if (c.type === 'terminal') parts.push(`[terminal ${c.terminalId}]`)
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 4000)
}

function apply(c: Chat, u: SessionUpdate) {
  const last = c.entries.at(-1)
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (last?.kind === 'assistant') last.text += text(u.content)
      else c.entries.push({ kind: 'assistant', text: text(u.content) })
      break
    case 'agent_thought_chunk':
      if (last?.kind === 'thought') last.text += text(u.content)
      else c.entries.push({ kind: 'thought', text: text(u.content) })
      break
    case 'tool_call':
      c.entries.push({ kind: 'tool', id: u.toolCallId, title: u.title, toolKind: u.kind ?? 'other', status: u.status ?? 'pending', detail: toolDetail(u) })
      break
    case 'tool_call_update': {
      const tool = c.entries.find((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool' && e.id === u.toolCallId)
      if (!tool) { c.entries.push({ kind: 'tool', id: u.toolCallId, title: u.title ?? 'Tool', toolKind: u.kind ?? 'other', status: u.status ?? 'pending', detail: toolDetail(u) }); break }
      if (u.title) tool.title = u.title
      if (u.kind) tool.toolKind = u.kind
      if (u.status) tool.status = u.status
      const detail = toolDetail(u)
      if (detail) tool.detail = detail
      break
    }
    case 'plan': {
      const items = u.entries.map(e => ({ content: e.content, status: e.status }))
      const plan = c.entries.findLast(e => e.kind === 'plan')
      if (plan && plan.kind === 'plan' && c.entries.indexOf(plan) > c.entries.findLastIndex(e => e.kind === 'user')) plan.items = items
      else c.entries.push({ kind: 'plan', items })
      break
    }
    case 'config_option_update':
      c.options = u.configOptions
      break
    case 'session_info_update':
      if (u.title) c.title = u.title
      break
  }
}

function onEvent(e: AgentEvent) {
  if (e.type === 'status') { setStatus(e.message); return }
  if (e.type === 'install') { if (installs[e.providerId]) setInstalls(e.providerId, { received: e.received, total: e.total }); return }
  if (e.type === 'update') edit(e.chatId, c => apply(c, e.update))
  else if (e.type === 'permission' && !askFirst()) {
    const allow = e.options.find(o => o.kind === 'allow_once') ?? e.options.find(o => o.kind === 'allow_always')
    void bridge?.respond(e.chatId, e.requestId, allow?.optionId ?? null)
  } else if (e.type === 'permission') edit(e.chatId, c => { c.permissions.push({ requestId: e.requestId, toolCall: e.toolCall, options: e.options }) })
  else if (e.type === 'permission-resolved') edit(e.chatId, c => { c.permissions = c.permissions.filter(p => p.requestId !== e.requestId) })
  else if (e.type === 'options') edit(e.chatId, c => { c.options = e.options })
  else if (e.type === 'exit') edit(e.chatId, c => { c.ended = true; c.running = false; c.permissions = []; c.paused = true; c.entries.push({ kind: 'notice', tone: 'error', text: `Agent stopped: ${e.message}` }) })
}
