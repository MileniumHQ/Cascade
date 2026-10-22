/**
 * Agent panel contract: external coding agents (Claude, Codex, OpenCode…) driven over
 * the Agent Client Protocol by the main process. Each chat is one agent subprocess + one ACP session,
 * with Cascade's MCP server attached so the agent can edit the open project.
 */
import type { PermissionOption, SessionConfigOption, SessionUpdate, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk'

export type { PermissionOption, SessionConfigOption, SessionUpdate, StopReason, ToolCallUpdate }

export interface AgentProvider {
  id: string
  name: string
  /** Icon key for the UI. */
  icon: 'claude' | 'codex' | 'cursor' | 'opencode' | 'agent'
  available: boolean
  /** Why it can't start (not installed, etc.). */
  reason?: string
  /** Cascade can download it from the ACP registry (size in bytes when known). */
  install?: { size?: number }
}

export interface AgentSession {
  /** Local chat id (not the agent's session id). */
  id: string
  providerId: string
  /** Agent-reported name/version, e.g. "Claude Agent 0.94.0". */
  agent: string
  /** Model, effort, mode… exactly as the agent offers them. */
  options: SessionConfigOption[]
  /** False when the agent cannot reach Cascade's MCP server (tools unavailable). */
  cascadeTools: boolean
  /** The agent's own session id (what `resume` takes). */
  sessionId: string
  cwd: string
  /** True when `resume` reloaded the earlier conversation; false = fresh session. */
  resumed: boolean
  /** Why `resume` fell back to a fresh session. */
  resumeError?: string
  /** The agent accepts image prompt blocks. */
  images: boolean
}

/** Sent with a prompt: images inline (base64), files as links to their path on disk. */
export type AgentAttachment =
  | { kind: 'image'; name: string; mimeType: string; data: string }
  | { kind: 'file'; name: string; path: string }

export interface StartOptions {
  /** Working directory to reuse (a resumed chat's). Defaults to the project's workspace. */
  cwd?: string
  /** Open project id: new chats work in `<userData>/workspaces/<id>`, one folder per project. */
  project?: string
  /** Agent session id to reload (ACP session/load) when the agent supports it. */
  resume?: string
}

/** A plan limit: share used so far (0–100) and when it resets, in the agent's own wording. */
export interface UsageMeter { label: string; percent: number; resets?: string }
/** `sub` rows break down the row above them. */
export interface UsageStat { label: string; value: string; sub?: boolean }
/** Plan usage for one agent, as far as it reports it. */
export interface AgentUsage { meters: UsageMeter[]; stats: UsageStat[]; note?: string }

/** A model provider an agent can take an API key for (OpenCode's /connect). */
export interface KeyProvider { id: string; name: string; connected: boolean }

export type AgentEvent =
  | { chatId: string; type: 'update'; update: SessionUpdate }
  | { chatId: string; type: 'permission'; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { chatId: string; type: 'permission-resolved'; requestId: string }
  | { chatId: string; type: 'options'; options: SessionConfigOption[] }
  | { chatId: string; type: 'exit'; message: string }
  /** Start-up progress not tied to a visible chat yet (e.g. waiting for browser sign-in). */
  | { type: 'status'; providerId: string; message: string }
  | { type: 'install'; providerId: string; received: number; total: number }

export interface AgentsBridge {
  providers(): Promise<AgentProvider[]>
  /** Spawn the agent and open (or resume) a session. */
  start(providerId: string, options?: StartOptions): Promise<AgentSession>
  /** Resolves when the turn ends; streaming arrives through onEvent. */
  prompt(chatId: string, text: string, attachments?: AgentAttachment[]): Promise<StopReason>
  cancel(chatId: string): Promise<void>
  setOption(chatId: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]>
  /** `optionId` null = dismiss (cancelled). */
  respond(chatId: string, requestId: string, optionId: string | null): Promise<void>
  close(chatId: string): Promise<void>
  /** Download a registry agent into Cascade's data folder (progress via `install` events). */
  install(providerId: string): Promise<void>
  /** Plan limits / token use for an agent (cached briefly; `fresh` refetches). */
  usage(providerId: string, fresh?: boolean): Promise<AgentUsage>
  /** Model providers the agent can be given an API key for (empty when it manages its own sign-in). */
  keyProviders(providerId: string): Promise<KeyProvider[]>
  /** Save (or replace) the agent's API key for a model provider. */
  saveKey(providerId: string, target: string, key: string): Promise<void>
  /** Remove the agent's saved credentials for a model provider. */
  removeKey(providerId: string, target: string): Promise<void>
  onEvent(fn: (event: AgentEvent) => void): () => void
}
