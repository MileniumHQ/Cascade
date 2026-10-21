# Agent panel

The **Agent** side panel (sparkles icon in the left sidebar switcher) runs coding agents inside Cascade over the [Agent Client Protocol](https://agentclientprotocol.com) (`@agentclientprotocol/sdk`). Every chat gets Cascade's MCP server attached, so the agent edits the open project live and undoably.

## Agents
| Agent | How it runs | Sign-in |
|---|---|---|
| Claude | bundled `@agentclientprotocol/claude-agent-acp` (Claude Agent SDK, which ships Claude Code) | your existing `claude` login |
| Codex | bundled `@agentclientprotocol/codex-acp` (`@openai/codex`) | your existing `codex login` |
| Cursor | `cursor-agent acp` from PATH, or **Install** in the picker (official build from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), ~184 MB, kept in `<userData>/agents/cursor`) | browser login on first use |
| OpenCode | Cascade's install (ACP registry) or `opencode acp` from PATH | **Connect provider** in the model picker, or opencode's own config |

Bundled adapters run as Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`). PATH lookups also check `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin` and nvm, because GUI launches often miss your shell PATH. Unavailable agents appear dimmed in the picker, with the reason in the tooltip. There's no Gemini CLI or Antigravity launcher on purpose. Any model an agent offers (including Gemini models in Cursor or OpenCode) shows up in its model list unfiltered.

**Sign-in:** if `session/new` fails with ACP `auth_required`, the host calls `authenticate` with the agent's first interactive method (env-var methods are skipped). For Cursor that opens a browser login; the panel shows "Finish signing in…" until it resolves. If the agent can't open a browser, the login link appears above the composer.

Anthropic's Agent SDK branding rules don't allow a partner product to call it "Claude Code", so the picker says **Claude**.

## Usage
The gauge chip in the composer shows usage for the current chat's agent (`agents:usage`, `src/main/agents/usage.ts`; cached 60 s):
- **Claude** / **Codex**: the agent's own `/usage` / `/status` command, run in a throwaway ACP session (temp cwd, no MCP). These commands are local and make no model call. The markdown reply is parsed into 5-hour and weekly meters. Claude records that session as "/usage" in `~/.claude/projects/-tmp…`.
- **Cursor**: `DashboardService/GetCurrentPeriodUsage` + `GetPlanInfo` on `api2.cursor.sh`, the same calls `cursor-agent` makes, using its saved login (`~/.config/cursor/auth.json`, `~/.cursor/auth.json` on macOS, `%APPDATA%\Cursor\auth.json` on Windows). It gives included-usage % (total, Auto, API models) and the reset time.
- **OpenCode**: `opencode stats --standalone --json --models` for today and the last 7 days. Free models (priced at 0 in OpenCode's cached models.dev catalog, `~/.cache/opencode/models.json`, or ending in `-free`) are totalled separately. When a paid sibling exists (`x-free` → `x`), the same tokens are priced at its rates as "Saved vs. paid versions". Zen publishes no free-tier quota, so there's no meter.
- Below that, a "This chat" row shows context fill and cost from ACP `usage_update` (OpenCode and Claude send it).

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
- OpenCode installs in-app like Cursor (ACP registry `opencode`, sha256-checked). Cascade's own install wins over PATH. The registry ships the stable 1.x; `@opencode/cli` is 2.x. They differ in stats (2.x `stats --standalone --json`; 1.x text report, parsed by `parseOpencodeStatsText`) and credentials (2.x `opencode auth`; 1.x `<XDG data>/opencode/auth.json`), so the host checks `opencode --version` first.
- **Connect provider** (OpenCode only, in the model picker header) is OpenCode's `/connect` without its TUI: providers come from the cached models.dev catalog (fetched from models.dev if missing), connected ones from `opencode auth list`. On 2.x, saving pipes the key to `opencode auth import --standalone` over stdin (never argv), then logs out the integration's previous credentials so the new key replaces them; on 1.x it writes `{ type: 'api', key }` into auth.json (mode 0600). An unused OpenCode chat restarts so its model list includes the new provider. API keys only; OAuth logins (Copilot, Claude Pro) still need `opencode auth login`.
