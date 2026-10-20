# Research notes: MCP + captioning (2026-10-20)

## MCP
- Spec 2026-07-28 is stateless (no initialize/session). TS SDK v2: `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (`createMcpHandler`, `toNodeHandler`, `localhostHostValidation`, `localhostOriginValidation`). v1 (`@modelcontextprotocol/sdk`) still maintained; older clients may still speak 2025-era sessions — test actual clients.
- Bind 127.0.0.1, validate Host/Origin, bearer token generated at startup; show copy-paste `claude mcp add --transport http cascade http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"`.
- Also ship a stdio proxy entry (`cascade-mcp --stdio`) for clients without HTTP support.
- Claude Code limits: MAX_MCP_OUTPUT_TOKENS default 25k (warn >10k). Images count against it → contact sheets (one JPEG grid ≤1568px long edge, 6–12 cells, timecode labels + text mapping) rather than many frames.
- Tool design: ~25 tools, prefixed (`project_*`, `media_*`, `timeline_*`, `captions_*`, `export_*`), batch edits (`timeline_apply_edits(ops[])`), compact text timelines (one line per clip), `detail: concise|detailed`, `isError` results with recovery hints, short readable ids, `undo`/`history`, job-id + `job_get` for long work (+ progress notifications when a progressToken is supplied), readOnly/destructive annotations, deterministic tool order.
- Agent loop for "edit my Minecraft video": transcribe → silence/scene detect → contact sheets → apply edits → timeline preview sheet → export.

## Captioning
- Primary: whisper.cpp `whisper-cli` built with Vulkan (works on RADV / RX 7800 XT), models `ggml-large-v3-turbo(.q5_0).bin` from huggingface.co/ggerganov/whisper.cpp, Silero VAD ggml model. No official release binaries → build/ship our own (CPU fallback build).
  `whisper-cli -m ggml-large-v3-turbo.bin -f audio16k.wav -l auto -ojf -of out -ml 1 -sow -dtw large.v3.turbo -fa --vad -vm ggml-silero-v6.2.0.bin -np -pp` (verify flag spellings against the built version).
- Candidate upgrade: Parakeet TDT 0.6B v3 (lower WER, native word timestamps) via whisper.cpp `parakeet-cli` GGUF or sherpa-onnx — spike before adopting.
- Fallbacks: smaller whisper model on CPU; optional cloud providers (user API key, opt-in).
- Group words into caption lines inside Cascade; optional energy-based boundary refinement; `--prompt` with domain vocabulary.
