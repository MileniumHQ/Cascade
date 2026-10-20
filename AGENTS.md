# Cascade — agent notes

DOM-powered video editor. Electron 44 + TypeScript (TS 7 / tsgo) + SolidJS + plain CSS. Package manager: **bun**.

## Commands
- `bun run typecheck` — must pass (`tsc --noEmit`).
- `bun run test` — vitest, tests live next to code as `*.test.ts`.
- `bun run build` — electron-vite build to `out/`.
- `bun run dist:linux` — packaged Linux x64 build (AppImage + `dist/linux-unpacked/`); builds whisper first if missing (`bun run setup:whisper`). Only Linux x64 is targeted for now.
- `bun run dev` — dev app. **This environment sets `ELECTRON_RUN_AS_NODE=1`; unset it** (`env -u ELECTRON_RUN_AS_NODE bun run dev`) or Electron starts as plain Node.

## Driving the real app (screenshots / e2e)
- `node scripts/drive.mjs <shotsDir> <steps.mjs>` launches the built app (`bun run build` first) via Playwright `_electron`, at 1600×960, and runs `default async ({ app, win, shot, sleep })`. `window.cascadeApp` exposes `CascadeAPI` (`edit`, `playback`, `selection`, `view`, `registries`…). Example: `scripts/steps-example.mjs`. `CASCADE_EXE=dist/linux-unpacked/cascade` drives the packaged build instead.
- Isolation env vars: `CASCADE_USER_DATA` (profile dir; driver defaults to `/tmp/cascade-test-profile`; user plugins live in `<profile>/plugins`) and `CASCADE_PROJECTS` (projects dir).
- Test footage: `~/wwdc.webm` (1h48m AV1 1080p 29.97 + Opus). The first ~5s are black; seek to e.g. 600s for content.

## Agent editing
- MCP tools are documented in `docs/mcp.md`. Content-aware editing (`media_analyze` → `transcript_get`, then ordinary ops with word anchors like `w12.end+80ms`) lives in `src/plugins/builtin/mcp/transcript.ts`, built on the `SourceAnalysis` contract in `src/shared/analysis.ts`. Keep agent tools as information + primitives; don't add hard-coded editing macros.
- Resource limits: run one GPU-heavy job at a time (whisper Vulkan, export, Electron test instance); the machine has crashed under load.

## Agent panel
- Left sidebar "Agent" panel runs Claude Code / Codex / OpenCode / Gemini over ACP with Cascade's MCP attached. See `docs/agents.md`; host in `src/main/agents/`, UI in `src/plugins/builtin/panels/agent/`.

## User plugins
- `.ts/.tsx/.js/.mjs` files in `<userData>/plugins` are bundled with esbuild and hot-reloaded on save. Default-export a `PluginDefinition`. Example: `examples/plugins/wiggle.ts` (typecheck with `tsc -p tsconfig.examples.json`).

## Layout
- `src/shared/` — pure types/utilities used everywhere: `time.ts` (flicks, timecode), `project.ts` (document schema), `ipc.ts` (`HostBridge` = `window.cascade`).
- `src/core/` — the kernel: `plugin-api.ts` (THE plugin contract), `plugin-host.ts`, `registry.ts`, `document.ts` (immer + undo), `editing.ts` (all undoable edit ops), `timeline-ops.ts` (pure overwrite/split/trim logic), `evaluate.ts` (keyframes/easing), `app.ts` (services + `CascadeAPI`).
- `src/stage/` — renders (project, time) to DOM. Runs in the preview iframe and in export workers.
- `src/plugins/builtin/<name>/index.ts` — every feature is a built-in plugin (`definePlugin`). Media types, properties, panels, easings, inputs…
- `src/renderer/` — windows: `index.html` (editor), `splash.html`, `render.html` (headless export worker). `ui/` = shared UI kit.
- `src/main/` — Electron main: windows, protocols (`media://`, `cascade-plugin://`), ffmpeg services, export orchestration, MCP server.
- `src/preload/` — exposes `HostBridge` (see `src/shared/ipc.ts`).

## Rules
- Time is integer **flicks** (`FLICKS = 705_600_000`/s). Never store seconds or frames in the document.
- The stage never uses px. Spatial values are stored as frame fractions; plugins emit CSS via `StageUnits` (`cqw`/`cqh`). The UI can show px (reference resolution) freely.
- All document mutations go through `app.edit.*` / `doc.transact` (undoable). Never mutate project objects directly (they're frozen).
- The core must not know specific media types/properties — those belong in plugins.
- UI contribution points are framework-agnostic `mount(el, ctx) => cleanup`.
- Visual design: dark neutral greys (not blue-tinted), glassy popovers, accents lime `#c6f24e` and light blue `#82cbff` at reduced opacity. Font: Commissioner.
