# Headless export pipeline

`export.start(request)` returns the job id before sending progress. It renders half-open timeline ranges `[start, end)` in flicks. Video frame count is `ceil((end-start) * fps / FLICKS)`; the final frame's duration rounds video/audio output duration up together. Audio-only outputs use the requested duration exactly.

## Export panel integration

```ts
const exporter = app.registries.exporters.get(exporterId)!
const info = await app.host!.info()
const options = Object.fromEntries(exporter.options.map(p => [p.id, p.default]))
// Apply the panel's option values to options here.
const encoding = exporter.ffmpeg(options, {
  width, height, fps,
  hasAudio: true, // false omits the audio pass for video formats
  hwEncoders: info.ffmpeg.hwEncoders
})
const jobId = await app.host!.export.start({
  project: app.project(), timelineId: app.project().activeTimeline,
  width, height, fps, range: { start, end }, output,
  exporter: exporter.id, options, encoding, workers: 0
})
```

PNG sequence `output` is a **directory**; files are named `frame-00000001.png`, etc. Other exporters receive an absolute output file path. Existing files are replaced only once the complete result is ready. A nonempty existing sequence directory is preserved and produces an error.

Subscribe with `export.onProgress` before starting. States are `preparing → rendering → encoding → muxing → done`, or `audio → muxing → done` for audio-only jobs. `error` and `cancelled` terminate a job. `fps` includes initialization, capture, encoding and muxing elapsed time. Encoding overlaps capture; `encoding` also marks the completion of the streamed video pass. Progress includes `stalePaints` and the actual worker count. `cancel(jobId)` waits for process exit and temporary-file cleanup; it is restricted to the job's originating webContents.

`export.frame` keeps one offscreen window warm for 30 seconds. It serializes calls, accepts the current project on every call, keeps monotonic video decoders warm, seeks for sparse requests, and rebuilds the stage for a different project. Its PNG data URL is the only base64 encoding in the pipeline. Video frames stay native BGRA buffers in main; audio uses the existing binary ArrayBuffer IPC bridge (structured clone, not base64).

## Contracts changed

- `src/shared/ipc.ts`: added `FFmpegExportPlan`, required `ExportRequest.encoding`, optional `ExportProgress.stalePaints/workers`, and `encoding/muxing` states. Kept existing progress states for compatibility. `RenderWorkerJob.pcmSources` maps media ids to temporary stereo f32le ranges with source offset, sample rate and frame count.
- `src/core/plugin-api.ts`: required `ExporterContribution.ffmpeg(options, info) → FFmpegExportPlan`; `info` contains dimensions, rational fps, audio presence and available hardware encoders.
- `src/stage/stage.ts`: added only `renderAudioChunk(project, timelineId, start, duration)`. It mounts every overlapping audio-capable instance, schedules `prepare`, evaluates audio properties at 100 Hz including clip boundaries, and gates sources at their exact bounds. Existing stage methods are unchanged.
- `render:done` is the worker initialization handshake. No preload or bridge signature changes were needed.

Plans provide output option/value pairs, container/extension, optional segment container, concat safety, audio/sequence kind, optional GIF palette pass, device arguments and software fallback. Main validates argument structure and permitted output flags; inputs, paths, frame rate, dimensions, stream mapping, duration and concat/mux lifecycle belong to main. Main never switches on an exporter id. New codec-specific flags need to be added to the explicit validation sets in `plan.ts`.

## Implementation and trade-offs

Each video segment has one offscreen BrowserWindow and one ffmpeg process. Segment boundaries are integer frame indices. Audio is decoded once per media's used source span to a temporary stereo f32le file, then fetched in byte ranges by a single worker using 10-second OfflineAudioContext chunks. This avoids renderer codec differences and bounds renderer PCM memory. Decoding uses output-side seeking to preserve Opus codec priming; input-side `-ss 0` on the test file advanced audio by 20 ms. See [ffmpeg seeking documentation](https://ffmpeg.org/ffmpeg.html#Main-options).

The stage uses the preview's render-mode plugins, plus user plugins. The output area fills the requested dimensions and the stamp occupies eight extra rows. Paints are accepted only when all eight stamp nibbles match. Stale checks copy only one stamp row for normal widths; the accepted BGRA buffer is cropped using a subarray. Re-invalidation runs on a 4 ms timer because synchronously invalidating stale paints can repeatedly return a cached bitmap and starve the compositor.

Auto parallelism is `min(cores/2, 6, 12.5 million / output pixels)`, with a floor of one. On the test machine that means six workers at 1080p and one at 4K. Explicit worker counts up to 32 are supported. ffmpeg encoder threads are divided across segment workers and filter threads are bounded. A hardware failure kills the entire segment attempt and retries all segments with identical software settings. Audio continues independently.

Temporary output lives beside the destination, allowing an atomic final rename. All processes/windows belong to cancellable scopes; errors, cancellation, owner destruction and application shutdown close them and remove temporary data.

### Necessary extra file

`src/plugins/builtin/media/decoder.ts` required a focused correctness fix outside the assigned export paths. Its existing demand-fed `canvasesAtTimestamps` iterable deadlocked: mediabunny batches timestamps until a keyframe boundary or iterator completion, while the caller waited for the first frame before supplying another timestamp. It now uses a bounded sequential canvas iterator with one frame of lookahead, preserving frame-exact selection, higher-output-fps repeats, backwards seeks and sparse contact sheets. Disposal while audio capability probing reads video metadata is also handled. Public contracts are unchanged; regression tests live under the owned export directory.

## Verification harnesses

- `benchmark.steps.mjs`: real Electron app, AV1/Opus `~/wwdc.webm`, animated text on V2, rational 30000/1001 fps. Cases are supplied by `CASCADE_BENCH_CASES`; output defaults to `/tmp/cascade-export-bench`. Each result includes ffprobe decoded frame counts and durations. Run with the repository's `scripts/drive.mjs` and an isolated profile.
- `verify.steps.mjs`: format smoke tests, failed-VAAPI fallback, immediate/active cancellation, warm-project edits, a 1×1 PNG, and a synthetic audio project covering mid-chunk starts, a clip crossing the 10-second boundary, animated gain, 2× playback speed and a muted track.
- `docs/export/verify-av.py`: source/export PCM cross-correlation using existing Python/NumPy. No app dependency was added.
- `plan.test.ts`, `decoder.test.ts`: frame partitions, range rounding, stamp validation, all built-in plans, argument validation and streaming decoder selection/liveness.

## Known limits

- Hardware selection currently uses VAAPI on `/dev/dri/renderD128`; other backends use software. Host detection is reused unchanged.
- Temporary PCM uses about 384 KB/s per used source span plus the final mix at 48 kHz stereo. Widely separated uses of one source decode the enclosing span. Memory remains chunk bounded; temporary disk usage grows with duration.
- Chunk contexts reset stateful audio effects every ten seconds; effects with long tails or lookahead need overlap/state transfer in a later change. Built-in gain/pan automation and clip boundaries are covered by verification.
- Positive audio speeds are supported; reverse audio produces a clear error. Output seeking can decode audio before the selected source range to preserve exact timing.
- GIF and PNG sequences run as one segment. GIF uses a lossless FFV1 intermediate and palette generation/application passes.
- Capture uses sRGB BGRA; HDR/10-bit mastering and transparent video workflows are not implemented.

## Measured results (2026-10-20)

AMD Ryzen 5 7600, 12 logical CPUs, AMD VAAPI, Electron 44.9.1, ffmpeg n9.0.2. Source: `~/wwdc.webm`, AV1 1920×1080 / 30000/1001 fps with Opus, 1h48m. Every case contains the same animated Commissioner text overlay. Times include worker startup, audio preparation/mixing, video encoding and final mux; ffprobe validation time is excluded. The machine was shared with other development tasks, so these are single-run measurements.

| Requested range | Output | Encoder | Workers | Wall seconds | Frames/s | × realtime | Rejected stale paints |
|---|---|---|---:|---:|---:|---:|---:|
| 60 seconds | 1080p | libx264 veryfast | 1 | 23.867 | 75.38 | 2.51 | 3,019 |
| 60 seconds | 1080p | libx264 veryfast | 6 | 18.712 | 96.14 | 3.21 | 2,752 |
| 60 seconds | 1080p | H.264 VAAPI | 1 | 22.267 | 80.79 | 2.69 | 3,076 |
| 60 seconds | 1080p | H.264 VAAPI | 6 | 14.579 | 123.40 | 4.12 | 2,686 |
| 60 seconds | 4K | libx264 veryfast | 1 | 57.229 | 31.44 | 1.05 | 3,677 |
| 60 seconds | 4K | H.264 VAAPI | 1 | 37.606 | 47.84 | 1.60 | 3,590 |
| 10 minutes | 1080p | H.264 VAAPI | 6 | 128.095 | 140.39 | 4.68 | 27,437 |

Realtime factor uses the requested range duration divided by wall time. Stale counts are rejected paint events, including repeated cached paints; no mismatched stamp is accepted.

- All six 60-second cases: **1,799 decoded video frames**, **60.026633 s** video; **60.026625 s** audio (under one 48 kHz sample apart).
- 10-minute case: **17,983 frames**, video **600.032767 s**, audio **600.032771 s** (under one sample apart).
- 1080p six-worker VAAPI: **1,799 unique decoded frame hashes**, zero consecutive duplicates.
- Source/export audio cross-correlation: **zero lag** both at the start (0.999576 correlation) and at 590 s (0.999804); the mix has no cumulative chunk drift.
- The synthetic 20-second mix has exactly **960,000 samples**. A 12 dB animated gain change measured **3.981074×** (expected 3.981072×); RMS matches exactly across a chunk boundary; 2× clip speed measured 880 Hz from a 440 Hz source; muted tracks and gaps are exactly silent.
- All additional format smoke tests passed: HEVC, VP9/Opus, software AV1/WebM, VAAPI AV1/MKV, ProRes 422 HQ/PCM, GIF, PNG sequence (15 files), WAV and MP3. Every visual smoke export had 15 frames. GIF quantizes duration to centiseconds as expected.
- Active six-worker cancellation completed cleanup in **88 ms**; immediate cancellation also passed. No temporary directories, cancelled output, ffmpeg processes or ffprobe processes remained. After tests there was only the main window plus the intentionally warm still-frame window.
- Broken VAAPI device retried all three segments in software and produced a valid 30-frame output. Warm project updates and a 1×1 PNG passed.
- Still frames at 0/15/30 s: **173 / 372 / 141 ms**. Sparse seeks include video decode, capture and PNG encoding.
- `npx tsc --noEmit -p tsconfig.json`, `npx electron-vite build`, `bun run typecheck`, `bun run test`: passed; **16 tests across 3 files**.


### Inspected images

- Editor screenshot: `/tmp/cascade-export-shots/export-project.png`
- Exported frames at indices 0 / 899 / 1798: `/tmp/cascade-export-bench/check-01.png`, `check-02.png`, `check-03.png`. The overlay moves left → center → right as keyed.
- Warm frame captures: `/tmp/cascade-export-bench/still-0.png`, `still-15.png`, `still-30.png`.
- Format test editor screenshot: `/tmp/cascade-export-formats-shots/export-project.png`.


### Files changed outside the primary export paths

- `src/plugins/builtin/index.ts`: register exporters in both plugin lists.
- `src/shared/ipc.ts`, `src/core/plugin-api.ts`: contracts listed above.
- `src/stage/stage.ts`: the one permitted audio chunk method.
- `src/plugins/builtin/media/decoder.ts`: necessary decoder liveness/disposal fix, isolated in commit `8c4e315`.

No preload changes, dependency changes, UI implementation, main-checkout edits or other-worktree edits. The pre-existing untracked `scripts/steps-example.mjs` is left untouched.
