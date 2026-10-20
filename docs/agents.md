# Agent panel

The **Agent** side panel (sparkles icon in the left sidebar switcher) runs coding agents inside Cascade over the [Agent Client Protocol](https://agentclientprotocol.com) (`@agentclientprotocol/sdk`). Every chat gets Cascade's MCP server attached, so the agent edits the open project live and undoably.

## Agents
| Agent | How it runs | Sign-in |
|---|---|---|
| Claude Code | bundled `@agentclientprotocol/claude-agent-acp` (Claude Agent SDK) | your existing `claude` login |
| Codex | bundled `@agentclientprotocol/codex-acp` (`@openai/codex`) | your existing `codex login` |
| Cursor | `cursor-agent acp` from PATH, or **Install** in the picker (official build from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), ~184 MB, kept in `<userData>/agents/cursor`) | browser login on first use |
| OpenCode | `opencode acp` from PATH | opencode's own config |

Bundled adapters run as Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`). PATH lookups also check `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin` and nvm, because GUI launches often miss your shell PATH. Unavailable agents appear dimmed in the picker, with the reason in the tooltip. There's no Gemini CLI or Antigravity launcher on purpose. Any model an agent offers (including Gemini models in Cursor or OpenCode) shows up in its model list unfiltered.

**Sign-in:** if `session/new` fails with ACP `auth_required`, the host calls `authenticate` with the agent's first interactive method (env-var methods are skipped). For Cursor that opens a browser login; the panel shows "Finish signing in…" until it resolves. If the agent can't open a browser, the login link appears above the composer.

## Architecture
- `src/main/agents/index.ts`: `createAgentHost` runs one agent subprocess per chat and talks ndjson ACP over its stdio. It does `initialize`, then `session/new` with `{type:'http', name:'cascade', url, Authorization}` when the agent supports http MCP. It relays `session/update`, permission requests, config options and process exit to the renderer (`agents:*` IPC; types in `src/shared/agents.ts`).
- `src/plugins/builtin/panels/agent/`: the panel plugin. `state.ts` is a Solid store that folds updates into entries; `Agent.tsx` holds the thread, composer, model picker and approval banner, laid out after T3 Code.
- The first prompt is prefixed with a short context preamble (`CONTEXT`) that names the Cascade tools.
- Model, effort, mode and other options are the agent's own ACP `configOptions`. The last value picked for each agent is remembered in localStorage and re-applied to new chats.

## Approvals
- Off by default: the panel answers each permission request with the agent's allow option. Cascade edits are undoable.
- **… → Ask before actions** turns approvals on. Each request then shows as a banner with the agent's own options.
- With approvals on, Claude still runs Cascade's read-only MCP tools without asking (`readOnlyHint` in `src/main/mcp/catalog.ts`, passed as `_meta.claudeCode.options.allowedTools`).
- The agent cwd is the Cascade projects dir. Cascade advertises no ACP fs or terminal capability, so agents use their own sandboxing.

## Composer
- **Queue:** Enter while the agent works queues the message, and the queue sends in order when the turn ends. After Stop or an error the queue pauses; each item has Send now and Remove.
- **Attachments:** paste, drop or use the paperclip. Images (≤ 8 MB) go as ACP image blocks when the agent advertises `promptCapabilities.image`; other files go as `file://` resource links.

## History
- The last 30 chats are kept in localStorage, trimmed, without image data. They are saved shortly after each change and when the window closes.
- Sending in a stopped or restored chat restarts the agent with `session/load` when it advertises `loadSession` (Claude, Codex and Cursor do). Replayed history is dropped because the thread already has it.
- If the agent can't reload, a fresh session starts. It replaces the saved session id, and the chat says so with the reason, only when the next message is sent. Codex can't reload sessions that never got a prompt, so opening the picker must not overwrite the saved id.

## Test
- `bun run test src/main/agents`: drives a fake ACP agent (`fake-agent.mjs`) through the real host.
- Packaged: `CASCADE_EXE=dist/linux-unpacked/cascade node scripts/drive.mjs …` drives the AppImage contents (adapters run from `app.asar.unpacked`).
- Real app: drive steps can open the panel with `.side-switch button[data-tip="Agent"]`, type into `.ag-composer textarea` and approve with `.ag-approval .ag-pill.primary`.

## Limits
- Images are not persisted in history, only their names.
- OpenCode must be installed separately.
