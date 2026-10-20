# Cascade — agent notes

DOM-powered video editor. Electron 44 + TypeScript (TS 7 / tsgo) + SolidJS + plain CSS. Package manager: **bun**.

## Commands
- `bun run typecheck` — must pass (`tsc --noEmit`).
- `bun run test` — vitest, tests live next to code as `*.test.ts`.
- `bun run build` — electron-vite build to `out/`.
- `bun run dev` — dev app. **This environment sets `ELECTRON_RUN_AS_NODE=1`; unset it** (`env -u ELECTRON_RUN_AS_NODE bun run dev`) or Electron starts as plain Node.

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
