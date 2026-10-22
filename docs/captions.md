# Local captions

`captions.generate` captions the selected video/audio clip, or the selected file in Sources. Both context menus offer **Generate captions**. Speech is processed on this computer; the first use asks to download models. The status bar shows progress and Cancel. Captions are editable element/text clips on a new **Captions** visual track, above all existing visual tracks. One undo removes the entire result.

## Setup

Run `bun run setup:whisper`. This builds `cascade-align` (word timing, below) and [whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5), pinned to `d1be6fde11ac6e0407606b4e42fe72d34add8037`, with `-DGGML_VULKAN=1` and static ggml/whisper libraries. Requirements: Git, CMake, a C/C++ toolchain, Vulkan loader/development headers (including Vulkan-Hpp), SPIRV-Headers CMake package, and `glslc`. Missing Vulkan prerequisites or a failed GPU build trigger a CPU build. `node scripts/setup-whisper.mjs --cpu` explicitly builds for CPU.

The binary, upstream license, and build metadata go into gitignored `resources/whisper/<platform>-<arch>/`. Packaged apps discover the same folder under `process.resourcesPath/whisper/`; packaging must copy it there. Development also searches the repository resources. Models go into `<userData>/models/`; cache files go into `<userData>/cache/transcripts/`. Nothing is installed into node_modules.

This workstation had the Vulkan loader, RADV and glslc but lacked development headers. For verification only, headers were cloned into this worktree's ignored `vendor/`: Vulkan-Headers and Vulkan-Hpp `v1.4.328`, SPIRV-Headers `vulkan-sdk-1.4.328.1`. Headers/SPIRV CMake metadata were staged into `vendor/vulkan-sdk`. Rebuild here with:

```sh
VULKAN_SDK="$PWD/vendor/vulkan-sdk" bun run setup:whisper
```

## Models and alignment

Default: [Whisper Large v3 Turbo Q8](https://huggingface.co/ggerganov/whisper.cpp/blob/0b364b566045a405be7225ee1e415a073e04da77/ggml-large-v3-turbo-q8_0.bin), **874,188,075 bytes** (833.69 MiB). Q8 preserves more precision than Q5 while fitting this GPU comfortably; Turbo's four decoder layers make full keynotes practical. [Silero VAD 6.2](https://huggingface.co/ggml-org/whisper-vad/blob/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin) adds **885,098 bytes**. URLs are pinned to model revisions, and downloads support HTTP Range resume and verify the published SHA-256 before atomic promotion. Installed status checks file size; completed downloads are not rehashed on every run.

FFmpeg extracts only the requested source range to 16 kHz mono PCM. Whisper runs with `--vad --dtw large.v3.turbo --no-flash-attn -ojf --split-on-word -pp`. Flash attention must be disabled because upstream disables DTW when it is enabled. The setup script applies a checked, idempotent patch to v1.9.5's full JSON path: the token-data getter bypasses upstream's VAD-aware timestamp accessors, so the patch maps token offsets and DTW times through upstream's segment-aware VAD mapper. Without this, silence removal causes source-time drift.

The parser joins BPE pieces into words, uses DTW anchors, and infers bounded word ends from the following anchor. Collapsed or reversed DTW anchors fall back to the independently estimated token offsets. If mixing those offsets with a neighboring DTW anchor reverses their order, the fallback expands to that neighbor. If both clocks collapse, words share the interval up to the next usable anchor; these interpolated boundaries are approximate. This DTW timing is the fallback; the aligner below replaces it. A simultaneous FFmpeg silence pass (`-35 dB`, at least 180 ms) trims word ends crossing silence and pulls nearby post-pause onsets to the acoustic boundary. All returned times are integer source-media flicks, including the requested range offset. Cache keys include source path, mtime, size, range, model, language, whether `cascade-align` is present, and the pipeline version (`qwen3fa-7`). Cancellation stops extraction/inference/downloads; partial downloads remain resumable, and partial transcripts never become cached results.

One failed GPU inference triggers one CPU (`-ng`) attempt, then latches CPU for the service's lifetime. A failed CPU attempt is surfaced without looping; cancellation never triggers a retry. Set `CASCADE_WHISPER_CPU=1` to force CPU and skip Vulkan discovery. Keep Vulkan inference separate from other GPU work on this workstation; the resumed Electron screenshot check used cached transcripts with this override.

## Word timing (Qwen3-ForcedAligner)

Whisper decides the words; [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B) (Apache-2.0) then places every word's start and end. `setup:whisper` also builds `cascade-align` (`native/cascade-align/main.cpp`) from [CrispASR v0.8.43](https://github.com/CrispStrobe/CrispASR) (MIT, pinned to `eb633d908120cc5f44b8af8cd4aeb1191f16bfd8`, its ggml fork as a submodule): only CrispASR's `qwen3_asr` library, with Vulkan on Linux and CPU-only (AVX2) on Windows, no BLAS or OpenMP, and the same glibc 2.34 portability check as whisper-cli. The model is the [Q8 GGUF](https://huggingface.co/cstr/qwen3-forced-aligner-0.6b-GGUF/blob/1ec5110602ccab18c878ddebedab0891e290a95c/qwen3-forced-aligner-0.6b-q8_0.gguf), **985,594,624 bytes**, SHA-256 `539df5dd0fe1721e378ac13bfac9a26b1260dafb62d892c518c1f21244762636`, downloaded with the other models.

`src/main/align.ts` cuts the transcript into chunks of 30–90 s at the widest pause between whisper's words (snapped into an FFmpeg silence when one overlaps it), with at most 1 s of audio beyond the outer words. Words are reduced to the aligner's units the way the upstream processor does it (letters, digits and apostrophes; one unit per CJK ideograph); punctuation-only words sit at the previous word's end. `cascade-align` loads the model once, runs one forward pass per chunk and returns 80 ms timestamp classes. A word whose start and end share a class gets that frame (up to the next word). A failed, malformed or out-of-range chunk keeps whisper's timing; a GPU failure retries on CPU, and a second failure keeps whisper's timing for the whole transcript. `Transcript.timing` (and the analysis `models.speech` string) records which one applies: `qwen3-forced-aligner-0.6b-q8` or `whisper-dtw`.

Checks (21 October 2026): on WWDC 600–660 s, Theo 150–210 s and a 40 s Minecraft voiceover (556 words), `cascade-align` matched the Python `qwen_asr` fp32 reference on every word but one (one 80 ms frame); Q5_0/Q4_K moved 2–3% of words by a frame, hence Q8. Linux Vulkan, Linux CPU (`-ng`) and the Windows build under wine gave the same results. A 15-minute Theo source (2,769 words) took 41 s end to end on the RX 7800 XT; its 150–210 s words were within a median 34 ms (max 126 ms) of the standalone clip, the 80 ms grid landing differently per chunk. Chosen over whisper DTW, MFA and Parakeet TDT by watching caption-sync and gap-removal renders of those clips. Precision is bounded by the 80 ms grid; published human-labelled error is about 30 ms mean (TIMIT/Buckeye).

Caption grouping accounts for clip speed before splitting at punctuation, pauses, length, and six-second reading spans. It balances at most two approximately 42-character lines, rebalances short trailing words, and aims for at least 0.7 seconds without overlap. A final clipped phrase or physically impossible dense speech can be shorter. Style uses Commissioner 750, white with a dark outline, frame-relative size/position, and a lower-third center at 84% frame height. Text remains ordinary editable plugin properties.

## Measurements (20 October 2026)

Linux x64, Ryzen 5 7600, Radeon RX 7800 XT / RADV, Vulkan device 0. Runtime status enumerated two Vulkan devices, including the integrated GPU. Timings are wall time, include FFmpeg extraction and JSON parsing, and exclude cache hits. The workstation also had other rendering work active.

| Work | Time / result |
| --- | --- |
| First Vulkan configure/build with local headers | 127.8 s |
| CPU fallback after missing Vulkan headers | 42.0 s |
| Later patched incremental Vulkan rebuild | 12.9 s |
| First 300–600 s run including both downloads and checksums | 17.439 s, 17.20× realtime |
| Resumed final 300–600 s run, installed models | 9.615 s, **31.20× realtime**, 764 words, 80 caption clips |
| Full WWDC file, 6,531.181 s, before crash | 218.380 s, **29.91× realtime**, 17,710 words |
| Single resumed full-file run, before final interpolation fix | 214.047 s, **30.51× realtime**, 17,710 words |
| Cached final five-minute result | 0.58 ms; no extraction/inference |

The five-minute output has integer times, zero overlapping words or caption clips, a minimum caption duration of 0.700 s, maximum line length 42, and maximum two lines. A real canceled download left 18,100,939 bytes, then resumed beyond that offset and passed its SHA-256 in 6.4 s.

The original full-file result contained 197 zero-duration words and grouping lost text. The first fallback reduced that to 113; inspection found regular offsets collapsed too. After the final fix, a streaming reparse of the retained full JSON in batches of 64 source segments checked all **17,710 words**: zero zero-duration words, zero overlaps, all text preserved by grouping, and maximum line length 42. This bounded check produced 1,925 caption groups; grouping across batch boundaries can change that count. The shortest group was **59 ms**, caused by dense repeated model output. Such passages need human correction; preserving every recognized word, the line limit, and non-overlap cannot also guarantee 0.7 s there. No second full-file inference was run after the final parser fix.

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

`CaptionsService` and `GenerateCaptionsOptions` are exported from `src/plugins/builtin/captions/index.ts`. The existing plugin contract exposes services through `ctx.app.services`. `Transcript`, `TranscriptSegment`, `TranscriptWord`, `TranscribeOptions`, `TranscribeStatus`, and `TranscribeProgress` live in `src/shared/ipc.ts`. The bridge has status/installModel/run/cancel/onProgress. There is one application-wide transcription job, with progress and cancellation scoped to the requesting renderer. A changed/deleted clip or switched project/timeline is rejected before insertion. `Editing.addTrack` accepts optional `{ name, clips, label }` so a plugin can create a populated track in one undoable edit. No MCP tool was added.

Verification: `bun run typecheck`, `bun run build`, and 86 Vitest tests pass. Regression tests cover collapsed/reversed DTW anchors, crossing fallback offsets, both clocks collapsing, text preservation through grouping at 1×/2× speed, one-shot CPU fallback after simulated GPU failure, cancellation without retry, and explicit CPU mode. The resumed real Electron app imported WWDC, created captions for a trimmed clip from the fresh cached transcript, checked single-step undo/redo, exercised both context-menu predicates, and canceled an uncached full-source request during extraction without creating a partial track. Before the crash, a separate clean profile exercised the first-use model confirmation and cancellation. The resumed driver used `CASCADE_USER_DATA=/tmp/wt-captions-profile`, `CASCADE_PROJECTS=/tmp/wt-captions-projects`, and `CASCADE_WHISPER_CPU=1`. Screenshots were inspected:

- `/tmp/wt-captions-shots/captions-timeline-preview.png`
- `/tmp/wt-captions-shots/captions-two-lines.png`
- `/tmp/wt-captions-shots/caption-progress.png`

Durable copies and measurement artifacts remain in this worktree's gitignored `vendor/resume-shots/`, `vendor/benchmark-resumed-range.json`, `vendor/benchmark-resumed-full.json`, `vendor/check-full-stream.log`, and `vendor/resume-waveform.json`.

Limits: English word grouping is the tested path; languages without whitespace need a future language-aware segmenter. Only the default transcription model and Silero are currently offered. CPU fallback builds, but its transcription speed was not benchmarked. Packaged distribution and non-Linux platforms were not smoke-tested. Silence detection is conservative and cannot replace human review of difficult audio.
