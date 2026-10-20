# Local captions

`captions.generate` captions the selected video/audio clip, or the selected file in Sources. Both context menus offer **Generate captions**. Speech is processed on this computer; the first use asks to download models. The status bar shows progress and Cancel. Captions are editable element/text clips on a new **Captions** visual track, above all existing visual tracks. One undo removes the entire result.

## Setup

Run `bun run setup:whisper`. This builds [whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5), pinned to `d1be6fde11ac6e0407606b4e42fe72d34add8037`, with `-DGGML_VULKAN=1` and static ggml/whisper libraries. Requirements: Git, CMake, a C/C++ toolchain, Vulkan loader/development headers (including Vulkan-Hpp), SPIRV-Headers CMake package, and `glslc`. Missing Vulkan prerequisites or a failed GPU build trigger a CPU build. `node scripts/setup-whisper.mjs --cpu` explicitly builds for CPU.

The binary, upstream license, and build metadata go into gitignored `resources/whisper/<platform>-<arch>/`. Packaged apps discover the same folder under `process.resourcesPath/whisper/`; packaging must copy it there. Development also searches the repository resources. Models go into `<userData>/models/`; cache files go into `<userData>/cache/transcripts/`. Nothing is installed into node_modules.

This workstation had the Vulkan loader, RADV and glslc but lacked development headers. For verification only, headers were cloned into this worktree's ignored `vendor/`: Vulkan-Headers and Vulkan-Hpp `v1.4.328`, SPIRV-Headers `vulkan-sdk-1.4.328.1`. Headers/SPIRV CMake metadata were staged into `vendor/vulkan-sdk`. Rebuild here with:

```sh
VULKAN_SDK="$PWD/vendor/vulkan-sdk" bun run setup:whisper
```

## Models and alignment

Default: [Whisper Large v3 Turbo Q8](https://huggingface.co/ggerganov/whisper.cpp/blob/0b364b566045a405be7225ee1e415a073e04da77/ggml-large-v3-turbo-q8_0.bin), **874,188,075 bytes** (833.69 MiB). Q8 preserves more precision than Q5 while fitting this GPU comfortably; Turbo's four decoder layers make full keynotes practical. [Silero VAD 6.2](https://huggingface.co/ggml-org/whisper-vad/blob/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin) adds **885,098 bytes**. URLs are pinned to model revisions, and downloads support HTTP Range resume and verify the published SHA-256 before atomic promotion. Installed status checks file size; completed downloads are not rehashed on every run.

FFmpeg extracts only the requested source range to 16 kHz mono PCM. Whisper runs with `--vad --dtw large.v3.turbo --no-flash-attn -ojf --split-on-word -pp`. Flash attention must be disabled because upstream disables DTW when it is enabled. The setup script applies a checked, idempotent patch to v1.9.5's full JSON path: the token-data getter bypasses upstream's VAD-aware timestamp accessors, so the patch maps token offsets and DTW times through upstream's segment-aware VAD mapper. Without this, silence removal causes source-time drift.

The parser joins BPE pieces into words, uses DTW anchors, and infers bounded word ends from the following anchor. Collapsed or reversed DTW anchors fall back to the independently estimated token offsets. A simultaneous FFmpeg silence pass (`-35 dB`, at least 180 ms) trims word ends crossing silence and pulls nearby post-pause onsets to the acoustic boundary. All returned times are integer source-media flicks, including the requested range offset. Cache keys include source path, mtime, size, range, model, language, and alignment version. Cancellation stops extraction/inference/downloads; partial downloads remain resumable, and partial transcripts never become cached results.

Caption grouping accounts for clip speed before splitting at punctuation, pauses, length, and six-second reading spans. It balances at most two approximately 42-character lines, rebalances short trailing words, and aims for at least 0.7 seconds without overlap. A final clipped phrase or physically impossible dense speech can be shorter. Style uses Commissioner 750, white with a dark outline, frame-relative size/position, and a lower-third center at 84% frame height. Text remains ordinary editable plugin properties.

## Measurements (20 October 2026)

Linux x64, Ryzen 5 7600, Radeon RX 7800 XT / RADV, Vulkan device 0. Runtime status enumerated two Vulkan devices, including the integrated GPU. Timings are wall time, include FFmpeg extraction and JSON parsing, and exclude cache hits. The workstation also had other rendering work active.

| Work | Time / result |
| --- | --- |
| First Vulkan configure/build with local headers | 127.8 s |
| CPU fallback after missing Vulkan headers | 42.0 s |
| Later patched incremental Vulkan rebuild | 12.9 s |
| First 300–600 s run including both downloads and checksums | 17.439 s, 17.20× realtime |
| Final 300–600 s run, installed models | 10.145 s, **29.57× realtime**, 764 words, 80 caption clips |
| Full WWDC file, 6,531.181 s | 218.380 s, **29.91× realtime**, 17,710 words |
| Cached five-minute result | 2.0 ms; no extraction/inference |

The five-minute output has integer times, zero overlapping words or caption clips, a minimum caption duration of 0.700 s, maximum line length 42, and maximum two lines. A real canceled download left 18,100,939 bytes, then resumed beyond that offset and passed its SHA-256 in 6.4 s.

Timing spot check: extracted PCM, measured an independent 10 ms RMS envelope at -35 dB (180 ms sustained for silence ends), and compared six silence-adjacent word edges. These are acoustic checks, not human phonetic labels or a word-error-rate benchmark.

| Word edge | RMS boundary, source seconds | Transcript seconds | Absolute difference |
| --- | ---: | ---: | ---: |
| “free” end | 303.200 | 303.2323 | 32.3 ms |
| “Presenting” start | 304.180 | 304.1815 | 1.5 ms |
| “ever” end | 308.030 | 308.0554 | 25.4 ms |
| “Perhaps” start | 308.660 | 308.6597 | 0.3 ms |
| “developers” end | 311.680 | 311.7156 | 35.7 ms |
| “So” start | 312.510 | 312.5057 | 4.3 ms |

Mean absolute difference: **16.6 ms**, maximum **35.7 ms**, across these six edges. Raw DTW “Presenting” started at 304.410 s, 230 ms after the RMS onset, and the legacy final-token end for “free” extended to 304.160 s into silence; acoustic constraints correct these cases. Interior word boundaries retain DTW's 20 ms quantization and model uncertainty. This does not establish sub-frame accuracy for every word, especially under music, noise, or multilingual speech.

## Programmatic contract

```ts
// Renderer plugin / future MCP handler. Rejects errors; returns created clip IDs.
const captions = app.services.get('captions') as CaptionsService
await captions.generate({ clipId, language: 'en' })
await captions.generate({ mediaId, language: 'auto' }) // source starts at playhead
await captions.cancel()

// HostBridge: source-media flicks in and out, without timeline mutation.
await app.host.transcribe.status()
await app.host.transcribe.installModel('ggml-large-v3-turbo-q8_0.bin')
await app.host.transcribe.run(path, { range: { start, end }, language: 'en' })
const off = app.host.transcribe.onProgress(progress => { /* phase, progress 0..1 */ })
off()
```

`CaptionsService` and `GenerateCaptionsOptions` are exported from `src/plugins/builtin/captions/index.ts`. `Transcript`, `TranscriptSegment`, `TranscriptWord`, `TranscribeOptions`, `TranscribeStatus`, and `TranscribeProgress` live in `src/shared/ipc.ts`. The bridge has status/installModel/run/cancel/onProgress. There is one application-wide transcription job, with progress and cancellation scoped to the requesting renderer. A changed/deleted clip or switched project/timeline is rejected before insertion. No new core editing API or MCP tool was added.

Verification: `npx tsc --noEmit -p tsconfig.json`, `npx electron-vite build`, and 80 Vitest tests pass. The real Electron app imported WWDC, generated captions for a trimmed clip, checked single-step undo/redo, exercised both context-menu predicates, and canceled an uncached full-source request without creating a partial track. A separate clean profile exercised the first-use model confirmation and cancellation. Screenshots were inspected:

- `/tmp/wt-captions-shots/captions-timeline-preview.png`
- `/tmp/wt-captions-shots/captions-two-lines.png`
- `/tmp/wt-captions-shots/caption-progress.png`

Limits: English word grouping is the tested path; languages without whitespace need a future language-aware segmenter. Only the default transcription model and Silero are currently offered. CPU fallback builds, but its transcription speed was not benchmarked. Packaged distribution and non-Linux platforms were not smoke-tested. Silence detection is conservative and cannot replace human review of difficult audio.
