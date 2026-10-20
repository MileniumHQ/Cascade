/**
 * Agent panel contract: external coding agents (Claude Code, Codex, OpenCode, Gemini…) driven over
 * the Agent Client Protocol by the main process. Each chat is one agent subprocess + one ACP session,
 * with Cascade's MCP server attached so the agent can edit the open project.
 */
import type { PermissionOption, SessionConfigOption, SessionUpdate, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk'

export type { PermissionOption, SessionConfigOption, SessionUpdate, StopReason, ToolCallUpdate }

export interface AgentProvider {
  id: string
  name: string
  /** Icon key for the UI. */
  icon: 'claude' | 'codex' | 'opencode' | 'gemini' | 'agent'
  available: boolean
  /** Why it can't start (not installed, etc.). */
  reason?: string
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
  /** The agent accepts image prompt blocks. */
  images: boolean
}

/** Sent with a prompt: images inline (base64), files as links to their path on disk. */
export type AgentAttachment =
  | { kind: 'image'; name: string; mimeType: string; data: string }
  | { kind: 'file'; name: string; path: string }

export interface StartOptions {
  /** Defaults to the projects folder. */
  cwd?: string
  /** Agent session id to reload (ACP session/load) when the agent supports it. */
  resume?: string
}

export type AgentEvent =
  | { chatId: string; type: 'update'; update: SessionUpdate }
  | { chatId: string; type: 'permission'; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { chatId: string; type: 'permission-resolved'; requestId: string }
  | { chatId: string; type: 'options'; options: SessionConfigOption[] }
  | { chatId: string; type: 'exit'; message: string }

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
  onEvent(fn: (event: AgentEvent) => void): () => void
}
