import { createStore, produce } from 'solid-js/store'
import { createSignal } from 'solid-js'
import type { AgentEvent, AgentProvider, AgentsBridge, PermissionOption, SessionConfigOption, SessionUpdate, ToolCallUpdate } from '@shared/agents'

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind: string; status: ToolStatus; detail: string }
  | { kind: 'plan'; items: { content: string; status: string }[] }
  | { kind: 'notice'; text: string; tone: 'info' | 'error' }

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
}

const [chats, setChats] = createStore<Chat[]>([])
const [activeId, setActiveId] = createSignal<string | null>(null)
const [providers, setProviders] = createSignal<AgentProvider[]>([])
/** Provider chosen for the next chat, before any session exists. */
const [draftProvider, setDraftProvider] = createSignal(localStorage.getItem('cascade.agent.provider') ?? 'claude')
const [starting, setStarting] = createSignal(false)
export { chats, activeId, setActiveId, providers, draftProvider, starting }

export const active = () => chats.find(c => c.id === activeId()) ?? null
const index = (id: string) => chats.findIndex(c => c.id === id)
const edit = (id: string, fn: (chat: Chat) => void) => { const i = index(id); if (i >= 0) setChats(i, produce(fn)) }

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
  try {
    const session = await bridge.start(providerId)
    const chat: Chat = { id: session.id, providerId, agent: session.agent, title: 'New chat', entries: [], options: session.options, running: false, startedAt: 0, permissions: [], cascadeTools: session.cascadeTools, ended: false }
    if (previous && !previous.entries.length) closeChat(previous.id)
    setChats(chats.length, chat)
    setActiveId(chat.id)
    if (!session.cascadeTools) edit(chat.id, c => { c.entries.push({ kind: 'notice', tone: 'info', text: 'This agent could not attach Cascade’s editor tools, so it can chat but not edit the project.' }) })
    // Re-apply the user's last choices for this agent when they're still offered.
    for (const [configId, value] of Object.entries(remembered(providerId))) {
      const option = chat.options.find(o => o.id === configId)
      if (!option || option.currentValue === value) continue
      if (option.type === 'select' && !flatOptions(option).some(o => o.value === value)) continue
      await setOption(chat.id, configId, value, false).catch(() => {})
    }
    return active()
  } finally { setStarting(false) }
}

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
}

export async function send(text: string) {
  let chat = active()
  if (!chat || chat.ended) chat = await startChat()
  if (!chat || !bridge) return
  const id = chat.id
  edit(id, c => {
    c.entries.push({ kind: 'user', text })
    if (c.title === 'New chat') c.title = text.replace(/\s+/g, ' ').slice(0, 60)
    c.running = true; c.startedAt = Date.now()
  })
  try {
    const stop = await bridge.prompt(id, text)
    if (stop === 'refusal') edit(id, c => { c.entries.push({ kind: 'notice', tone: 'error', text: 'The agent declined this request.' }) })
    if (stop === 'max_tokens' || stop === 'max_turn_requests') edit(id, c => { c.entries.push({ kind: 'notice', tone: 'info', text: 'The agent stopped early (turn limit). Say “continue” to resume.' }) })
  } catch (error) {
    edit(id, c => { c.entries.push({ kind: 'notice', tone: 'error', text: message(error) }) })
  } finally {
    edit(id, c => { c.running = false; c.permissions = [] })
  }
}

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
  if (e.type === 'update') edit(e.chatId, c => apply(c, e.update))
  else if (e.type === 'permission') edit(e.chatId, c => { c.permissions.push({ requestId: e.requestId, toolCall: e.toolCall, options: e.options }) })
  else if (e.type === 'permission-resolved') edit(e.chatId, c => { c.permissions = c.permissions.filter(p => p.requestId !== e.requestId) })
  else if (e.type === 'options') edit(e.chatId, c => { c.options = e.options })
  else if (e.type === 'exit') edit(e.chatId, c => { c.ended = true; c.running = false; c.permissions = []; c.entries.push({ kind: 'notice', tone: 'error', text: `Agent stopped: ${e.message}` }) })
}
