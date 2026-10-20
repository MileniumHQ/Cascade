# Brief: export & long-video performance research

Goal: make long-video editing and export as fast as possible without losing frame/audio exactness. Read `docs/export.md` first (architecture, verification, benchmarks).

## Where things stand (2026-10-20, Ryzen 5 7600, AMD VAAPI, `~/wwdc.webm` 1h48m AV1 1080p 29.97)
- 1080p VAAPI, 6 workers: 4.1× realtime (60 s), 4.7× (10 min). CPU libx264, 1 worker: 2.5×.
- 4K: 1.6× (VAAPI) / 1.05× (CPU), single worker only measured.
- Exactness verified: all frames present and unique, A/V within one sample at 10 min, zero audio drift.

## Open questions, highest expected payoff first
1. **Stale paints:** the 10-min run rejected ~27k paints for ~18k frames, so capture does roughly 2× the necessary work. Find out why paints arrive before the stage settles (decoder readiness, paint stamp timing) and whether frames can be captured on a deterministic "ready" signal.
2. **Full-length run never done:** export the whole 1h48m at 1080p VAAPI. Record wall time, peak RAM, temp disk, and A/V sync at several points (`docs/export/verify-av.py`).
3. **Worker scaling:** going from 1→6 workers only gives ~1.5×. Profile where time goes (decode vs DOM paint vs BGRA readback vs IPC vs encode) and what saturates.
4. **4K:** multi-worker 4K was never measured; check whether readback/IPC bandwidth is the limit.
5. **Audio:** stateful effects reset every 10 s chunk (needs overlap/state transfer); temp PCM grows ~384 KB/s of source.
6. **Editor side with long sources:** timeline zoom/scroll, waveform and thumbnail generation, seek latency deep into the 1h48m file.

## Rules for the run
- One GPU-heavy job at a time (export, whisper Vulkan, or an Electron test instance): the machine has crashed under load. Close Electron instances when done.
- Work in a git worktree, not the main checkout. Keep memory bounded; no unbounded retry loops.
- Benchmark harness: `src/main/export/benchmark.steps.mjs` via `node scripts/drive.mjs` with an isolated profile (`CASCADE_USER_DATA`), cases via `CASCADE_BENCH_CASES`. Rebuild first (`bun run build`).
- Any speedup must re-pass the checks in `docs/export.md` (frame counts and hashes, A/V sync, format smoke tests). Report numbers in the same table format, noting that runs are single-shot on a shared machine.
- `bun run typecheck` and `bun run test` must pass.
