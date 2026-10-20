# Agent panel

The **Agent** side panel (sparkles icon in the left sidebar switcher) runs coding agents inside Cascade over the [Agent Client Protocol](https://agentclientprotocol.com) (`@agentclientprotocol/sdk`). Every chat gets Cascade's MCP server attached, so the agent edits the open project live and undoably.

## Agents
| Agent | How it runs | Sign-in |
|---|---|---|
| Claude Code | bundled `@agentclientprotocol/claude-agent-acp` (Claude Agent SDK) | your existing `claude` login |
| Codex | bundled `@agentclientprotocol/codex-acp` (`@openai/codex`) | your existing `codex login` |
| OpenCode | `opencode acp` from PATH | opencode's own config |
| Gemini CLI | `gemini --experimental-acp` from PATH | gemini's own config |

Bundled adapters run as Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`). PATH lookups also check `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin` and nvm, because GUI launches often miss your shell PATH. Unavailable agents appear dimmed in the picker, with the reason in the tooltip.

## Architecture
- `src/main/agents/index.ts`: `createAgentHost` runs one agent subprocess per chat and talks ndjson ACP over its stdio. It does `initialize`, then `session/new` with `{type:'http', name:'cascade', url, Authorization}` when the agent supports http MCP. It relays `session/update`, permission requests, config options and process exit to the renderer (`agents:*` IPC; types in `src/shared/agents.ts`).
- `src/plugins/builtin/panels/agent/`: the panel plugin. `state.ts` is a Solid store that folds updates into entries; `Agent.tsx` holds the thread, composer, model picker and approval banner, laid out after T3 Code.
- The first prompt is prefixed with a short context preamble (`CONTEXT`) that names the Cascade tools.
- Model, effort, mode and other options are the agent's own ACP `configOptions`. The last value picked for each agent is remembered in localStorage and re-applied to new chats.

## Safety
- The agent cwd is the Cascade projects dir. Cascade advertises no ACP fs or terminal capability, so agents use their own sandboxing and permission flow. Every permission request shows as an approval banner with the agent's options.
- Claude: Cascade's read-only MCP tools (`readOnlyHint` in `src/main/mcp/catalog.ts`) are pre-allowed through `_meta.claudeCode.options.allowedTools`. Edits, shell and file writes still ask in the default mode.
- Project edits go through `timeline_apply_edits` (one undo step per batch).

## Test
- `bun run test src/main/agents`: drives a fake ACP agent (`fake-agent.mjs`) through the real host.
- Real app: `.scratch`-style drive steps can open the panel with `.side-switch button[data-tip="Agent"]`, type into `.ag-composer textarea` and approve with `.ag-approval .ag-pill.primary`.

## Limits
- Chats live only as long as the app; they are not persisted or resumed.
- You can't queue or steer a prompt while the agent is working (use Stop first).
- Images and file attachments aren't supported in the composer.
