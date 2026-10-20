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
}

export type AgentEvent =
  | { chatId: string; type: 'update'; update: SessionUpdate }
  | { chatId: string; type: 'permission'; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { chatId: string; type: 'permission-resolved'; requestId: string }
  | { chatId: string; type: 'options'; options: SessionConfigOption[] }
  | { chatId: string; type: 'exit'; message: string }

export interface AgentsBridge {
  providers(): Promise<AgentProvider[]>
  /** Spawn the agent and open a session. `cwd` defaults to the projects folder. */
  start(providerId: string, cwd?: string): Promise<AgentSession>
  /** Resolves when the turn ends; streaming arrives through onEvent. */
  prompt(chatId: string, text: string): Promise<StopReason>
  cancel(chatId: string): Promise<void>
  setOption(chatId: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]>
  /** `optionId` null = dismiss (cancelled). */
  respond(chatId: string, requestId: string, optionId: string | null): Promise<void>
  close(chatId: string): Promise<void>
  onEvent(fn: (event: AgentEvent) => void): () => void
}
