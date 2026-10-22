# Cascade — agent notes

DOM-powered video editor. Electron 44 + TypeScript (TS 7 / tsgo) + SolidJS + plain CSS. Package manager: **bun**.

## Commands
- `bun run typecheck` — must pass (`tsc --noEmit`).
- `bun run test` — vitest, tests live next to code as `*.test.ts`.
- `bun run build` — electron-vite build to `out/`.
- `bun run dist:linux` — packaged Linux x64 build (AppImage, the `tar.gz` that Flathub repackages, `dist/linux-unpacked/`); builds whisper-cli + cascade-align first if missing (`bun run setup:whisper`). Linux ships as AppImage + Flathub only (no rpm/deb/pacman); the Flatpak manifest lives in `flatpak/`.
- `bun run flatpak [--lint]` — builds and installs the Flatpak (`com.mileniumhq.Cascade`) from `dist/Cascade-linux-x64.tar.gz` via `org.flatpak.Builder` (installed per user if missing). The manifest must keep `strip: false` (stripping cuts the payload off the Bun-compiled Claude binary). Inside Flatpak, userData is `~/.var/app/com.mileniumhq.Cascade/config/Cascade`, the in-app updater and `registerLinuxDesktop` are off (`FLATPAK_ID`). `--filesystem=home` needs a Flathub lint exception on submission; the app ID needs mileniumhq.com domain verification.
- `bun run release [patch|minor|x.y.z] [--no-win] [--dry-run]` — builds the pushed HEAD in a clean worktree (`vendor/release-<tag>`), tags it and publishes a GitHub release with the `latest*.yml` files that installed copies auto-update from (`src/main/updater.ts`: NSIS and AppImage; Flatpak updates through Flathub). The version comes from the newest `v*` tag; package.json isn't bumped. `CASCADE_UPDATE_URL=http://…` points the updater at a local folder of builds for testing.
- Platform `files:` lists in `electron-builder.yml` replace the top-level list: keep `out/**` + `package.json` in them, or the whole repo gets packed.
- `bun run dist:win` — Windows x64 NSIS installer, cross-built from Linux (`scripts/dist-win.mjs`): cross-compiles CPU-only (AVX2) `whisper-cli.exe` and `cascade-align.exe` with llvm-mingw (`setup-whisper.mjs --target win32-x64`, toolchain downloaded to `vendor/`), fetches Windows prebuilts that a Linux install skips (`scripts/fetch-win-deps.mjs`: sherpa-onnx, esbuild, Claude/Codex agent binaries, ffmpeg.exe — placed beside the Linux ones in `node_modules`), then electron-builder with wine. Each platform's `files` in `electron-builder.yml` excludes the other's binaries; add new native deps to both lists. Unsigned, so SmartScreen warns. Windows smoke test: `WINEDEBUG=-all wine resources/whisper/win32-x64/whisper-cli.exe --help`.
- `.cascade` file association: `fileAssociations` in `electron-builder.yml` (NSIS registers `resources/file-icon.ico`); on Linux `src/main/desktop-integration.ts` installs the per-user mime icon (+ a desktop entry when running as an AppImage) because electron-builder's mime XML names a generic icon. Opened files arrive via argv / `second-instance` / `open-file` → `HostBridge.window.onOpenFile`. Edit `resources/file-icon.svg`, then `node scripts/gen-file-icon.mjs` (needs `rsvg-convert`).
- Platform code: no `/`-only path handling (split on `/[\\/]/`), resolve CLIs with PATHEXT and spawn `.cmd` shims via `spawnCommand` (`src/main/agents/index.ts`), no Unix-only tools (`unzip`, `fc-list`) without a Windows branch.
- `bun run dev` — dev app. **This environment sets `ELECTRON_RUN_AS_NODE=1`; unset it** (`env -u ELECTRON_RUN_AS_NODE bun run dev`) or Electron starts as plain Node.

## Driving the real app (screenshots / e2e)
- `node scripts/drive.mjs <shotsDir> <steps.mjs>` launches the built app (`bun run build` first) via Playwright `_electron`, at 1600×960, and runs `default async ({ app, win, shot, sleep })`. `window.cascadeApp` exposes `CascadeAPI` (`edit`, `playback`, `selection`, `view`, `registries`…). Example: `scripts/steps-example.mjs`. `CASCADE_EXE=dist/linux-unpacked/cascade` drives the packaged build instead.
- Isolation env vars: `CASCADE_USER_DATA` (profile dir; driver defaults to `/tmp/cascade-test-profile`; user plugins live in `<profile>/plugins`) and `CASCADE_PROJECTS` (projects dir).
- Test footage: `~/wwdc.webm` (1h48m AV1 1080p 29.97 + Opus). The first ~5s are black; seek to e.g. 600s for content.

## Agent editing
- Transcripts: whisper.cpp supplies the words, `cascade-align` (Qwen3-ForcedAligner on CrispASR's ggml port, `native/cascade-align/`, chunking in `src/main/align.ts`) the word start/end times; see `docs/captions.md`.
- UI extension points (timeline decorations, inspector/source sections, drops, snap targets, viewer service, overlay input claims) are in `docs/ui-contributions.md`; keep feature UI in its plugin, never in the panels.
- MCP tools are documented in `docs/mcp.md`. Content-aware editing (`media_analyze` → `transcript_get`, then ordinary ops with word anchors like `w12.end+80ms`, or source anchors like `m1:w12` in `add_clip` sourceIn/sourceOut) lives in `src/plugins/builtin/mcp/transcript.ts`, built on the `SourceAnalysis` contract in `src/shared/analysis.ts`. `audio_analyze` renders the mix through the WAV exporter and measures/transcribes it (`mcp/audio.ts`, `mcp/loudness.ts`); `timeline_lint` rules live in `mcp/lint.ts`, contact sheets in `mcp/sheets.ts`, beat detection in `mcp/beats.ts`. MCP times print as `HH:MM:SS.mmm` (`mcp/clock.ts`) and parse back the same way. Keep agent tools as information + primitives; don't add hard-coded editing macros.
- Resource limits: run one GPU-heavy job at a time (whisper Vulkan, export, Electron test instance); the machine has crashed under load.

## Agent panel
- Left sidebar "Agent" panel runs Claude Code / Codex / Cursor / OpenCode over ACP (Cursor and OpenCode installable in-app from the ACP registry) with Cascade's MCP attached. See `docs/agents.md`; host in `src/main/agents/`, UI in `src/plugins/builtin/panels/agent/`.

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
- Clip speed is the keyframeable Speed property (`timeRemap`, plus a `timeReverse` toggle); linked audio follows its video. A reversed clip's `TimeMap.offset` is negative (sourceIn is the source time at clip start); use `sourceSpan()` for the used source range. Map timeline ↔ source with `app.edit.timeMap(clip)` / `ClipFrameState.remap`, never `clip.speed` (a legacy multiplier).
- The stage never uses px. Spatial values are stored as frame fractions; plugins emit CSS via `StageUnits` (`cqw`/`cqh`). The UI can show px (reference resolution) freely.
- All document mutations go through `app.edit.*` / `doc.transact` (undoable). Never mutate project objects directly (they're frozen).
- The core must not know specific media types/properties — those belong in plugins.
- UI contribution points are framework-agnostic `mount(el, ctx) => cleanup`.
- Icons: Material Symbols (Rounded, weight 300), inlined as SVG paths in the generated `src/renderer/ui/material-icons.ts`; never load the icon font or the whole set. `<Icon name>` / `iconMarkup()` / plugin `icon` fields take Cascade names (Lucide-style, e.g. `film`) or a bundled Material name. To add one: pick a symbol at fonts.google.com/icons (Rounded), check `node_modules/@material-symbols/svg-300/rounded/<name>.svg` exists (append `-fill` for filled), add `'my-name': 'material_name'` to `MAP` in `scripts/gen-icons.mjs`, run `node scripts/gen-icons.mjs`, commit both files. Unknown names render a "?" glyph. Missing from Material: hand-drawn glyphs go in `CUSTOM` in the same script (960-unit grid, `viewBox 0 -960 960 960`).
- Visual design: dark neutral greys (not blue-tinted), glassy popovers, no marketing taglines. Accents: neutral white (`--accent`), light blue `#82cbff` secondary at reduced opacity. Font: Inter. Custom title bar (`src/renderer/app/TitleBar.tsx`) with in-app File/Edit/… menus built from `app/*` menu contributions (`src/renderer/app/menu.ts`); the OS window buttons come from Electron's `titleBarOverlay`.
