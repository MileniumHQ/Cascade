# Cascade MCP

Cascade exposes **30 tools** that inspect and edit the project open in its editor. Edits appear immediately in preview and use the same editing APIs as the UI. A successful `timeline_apply_edits` batch is one undo step labeled `Agent: apply N edits` (or `Agent: split`, etc.). No additional packages are required: this implementation uses the installed `@modelcontextprotocol/sdk` v1 and Zod.

## Connect Claude Code

**Settings → Agents (MCP) → Connect an agent** shows ready-to-paste setups for Claude Code, Codex, Cursor, OpenCode, VS Code and generic `mcpServers` JSON, with the live URL, token and executable path filled in. Choose **In project** (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`, `.vscode/mcp.json`) or **Global** (user-level config), and HTTP or stdio. The snippet builder is `src/renderer/app/mcp-setup.ts`.

Start Cascade first. The existing **Settings → Agents (MCP) → MCP server** setting (`mcp.enabled`, default true) enables calls. Main prints the complete connection command, including the actual selected port and token, on every startup:

```sh
claude mcp add --transport http cascade http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"
```

Replace `<token>` with the contents of `<userData>/mcp-token`, or copy the startup command verbatim. `await window.cascade.info()` also returns `mcp: {url, enabled, token, command}` to the trusted editor. The token persists across restarts. The HTTP listener binds exclusively to `127.0.0.1`; if port 47823 is occupied it chooses an available port and prints the corrected command. Update the client configuration when that happens. The current endpoint and token are also written to `<userData>/mcp-endpoint.json` for the proxy; both credential files have mode 0600.

For clients requiring stdio, use the **same application executable and profile** as the running editor:

```sh
claude mcp add --transport stdio cascade -- env -u ELECTRON_RUN_AS_NODE /absolute/path/to/cascade --mcp-stdio
```

For a development checkout:

```sh
claude mcp add --transport stdio cascade -- env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Cascade/node_modules/electron/dist/electron /absolute/path/to/Cascade --mcp-stdio
```

The CLI flag starts only a stdio proxy: it reads the profile's endpoint file and connects to the running editor over authenticated HTTP. It does not take the editor's single-instance lock or open windows. stdout is exclusively MCP JSON-RPC; failures go to stderr. If the editor uses `CASCADE_USER_DATA`, pass that same environment variable to the proxy. Start the editor before starting the proxy.

## Transport and authorization

The server uses the v1 SDK's `StreamableHTTPServerTransport`, with a fresh stateless transport per request, SSE responses and no allocated session ids. SDK clients can initialize normally; subsequent requests need no session. Direct `tools/list` / `tools/call` requests work without initialization, and a legacy `Mcp-Session-Id` header is tolerated. GET and DELETE return 405 because there is no persistent SSE channel or session to remove. Use the Streamable HTTP transport rather than the older HTTP+SSE transport. No v2 package migration is necessary for this tool set.

Every request must have a local Host (`127.0.0.1` or `localhost`) and a valid `Authorization: Bearer …` header. An Origin, when present, must be an exact HTTP(S) localhost/loopback origin. Missing or bad credentials return 401; rejected Host/Origin returns 403. Disabling `mcp.enabled` rejects authenticated calls with 503 immediately, without restarting the app. The socket remains bound so re-enabling does not require reconfiguring clients. There is no browser CORS grant for arbitrary websites.

The bearer grants control of this local editor, including file import, project replacement, export paths and **trusted plugin code execution**. Keep it private. To rotate it, stop Cascade, delete `mcp-token`, then restart and update clients. Tool annotations describe read-only and destructive behavior; they do not replace authorization.

Calls execute in the renderer via the existing `mcp.onCall` / `mcp:reply` bridge. Main handles transport, authentication, validation and routing. Calls are serialized in the renderer. The forwarding timeout is three minutes; after a timeout inspect `timeline_get` / `history_get` before retrying a mutation, since timeout does not cancel work already running in the editor. Calls with a progress token receive running/completed notifications; asynchronous export frame counts are retrieved through `job_get`.

## Agent workflow

1. Inspect `project_get`, `timeline_get`, and `registry_list`. If no project is open, use `project_new` or `project_open`. Save before replacing an open project.
2. See the edit with `timeline_preview_sheet` or a range `contact_sheet`. Use `media_contact_sheet` to inspect raw sources before adding them.
3. Apply edits in batches with `timeline_apply_edits`.
4. Verify visually with sheets and inspect the resulting timeline. Undo mistakes with `timeline_undo`.
5. Listen with `audio_check`: it reports peaks, loudness, clipping and the words actually audible in the render.
6. Save with `project_save`; export with `export_start`, wait with `job_get` (`wait` up to 120 s), and optionally `export_cancel`.

**All times are integer flicks: 705600000 = one second.** Keyframe times are clip-local; placement, split, trim, marker and range times are timeline time. Ranges are half open `[start,end)`. Spatial values are frame fractions; e.g. position `[0.25, 0]` is one quarter frame width right of center. Use `registry_list` to discover units, ranges and property definitions. Never put floating-point seconds or pixel lengths in the document.

Tools are listed in deterministic order and accept `detail: "concise" | "detailed"` (concise by default). `project_get`, `media_list` and `timeline_get` expose additional document details in detailed mode. Concise `timeline_get` starts with a `user:` line (playhead timecode and flicks, whether it's playing, selected clip ids; `project_get` has the same as `editor`), then prints one line per clip: id, timecodes, `[start, end)` in flicks, source and source range, effective speed (`speed 2×`, `reversed`, `(from linked clip)` when a partner owns it), `linked=` partner ids, and only the parameters that differ from their defaults. Other tools return their compact domain-specific result. IDs such as `m1`, `c1`, `t1`, `p1` are stable aliases for the current editor lifetime; full document ids also work. Refresh ids after opening another project or restarting the editor. A batch `ref` is a temporary name usable by subsequent operations in that batch.

| Tools | Purpose |
| --- | --- |
| `project_get`, `project_new`, `project_open`, `project_save`, `project_settings_set` | Session and undoable project settings |
| `media_list`, `media_import`, `media_probe` | Sources; paths must be absolute or `~/…` |
| `timeline_get`, `timeline_apply_edits` | Inspect and edit the active timeline |
| `playhead_get`, `playhead_set` | Where the user is (playhead, playing, selection, clips under the playhead with clip-local/source times); move the playhead (flicks or anchor) and play/pause so the user sees a moment |
| `timeline_undo`, `timeline_redo`, `history_get` | Undo/redo and recent observed changes |
| `registry_list` | Media types, property parameters, easings, generators, exporters |
| `frame_get`, `contact_sheet`, `timeline_preview_sheet`, `media_contact_sheet` | Visual inspection |
| `plugin_write`, `plugin_list`, `plugin_remove`, `plugin_api_docs` | Property plugin authoring and hot reload |
| `export_start`, `job_get`, `export_cancel` | Asynchronous export jobs; `job_get(wait)` blocks until a job finishes (any job kind) |
| `audio_check` | Render the mix of a range as export does; peak/loudness/clipping overall and per clip, plus a transcript of what is audible |
| `media_analyze`, `transcript_get`, `transcript_search` | Edit by content: words, fillers, pauses, loudness, pitch and stress, sound events and shot cuts, on the timeline or in a source (`mediaId`). See [Editing by transcript](#editing-by-transcript) |
| `captions_generate`, `job_get` | Local Whisper captions for a clip (`clipId`) or source (`mediaId`); asynchronous, poll `job_get`. See [captions.md](captions.md) |

## Batch example

Import `~/wwdc.webm` with `media_import`; use the returned media id and track ids from `project_get`:

```json
{
  "ops": [
    {"op":"add_clip","mediaId":"m1","start":0,"duration":10584000000,"sourceIn":423360000000,"trackId":"t1","ref":"video"},
    {"op":"add_text","text":"Cascade · agent edit","start":0,"duration":7056000000,"trackId":"t2","ref":"title"},
    {"op":"add_keyframe","clipId":"title","propertyId":"transform","paramId":"position","time":0,"value":[-0.3,0]},
    {"op":"add_keyframe","clipId":"title","propertyId":"transform","paramId":"position","time":1411200000,"value":[0,0]},
    {"op":"split","clipId":"video","time":5644800000,"ref":"right"},
    {"op":"ripple_delete","start":7056000000,"end":8467200000},
    {"op":"add_marker","time":1411200000,"name":"Title lands"}
  ]
}
```

Result (trimmed):

```text
1. add_clip: ok c1 (video)
2. add_text: ok c2 (title)
3. add_keyframe: ok
4. add_keyframe: ok
5. split: ok c3 (right)
6. ripple_delete: ok
7. add_marker: ok
One undo step committed.
```

Supported operations: `add_clip`, `add_text`, `move`, `trim`, `split`, `delete`, `ripple_delete`, `set_param`, `add_keyframe`, `add_keyframes`, `wiggle`, `add_property`, `remove_property`, `add_marker`. Each operation has a strict schema in `tools/list`.

### Placing source ranges

`add_clip` takes the source range directly. `sourceIn`/`sourceOut` are source flicks or **source anchors** (`m1:w1043.start-40ms`, see below), and the timeline duration is derived as `(sourceOut − sourceIn) / speed` in whole frames (`sourceOut` defaults to the end of the source). Give `duration` instead of `sourceOut` to set the timeline length yourself. Other fields:

- `speed` (constant, 0.05–16) and `reverse: true` apply to the picture and its linked audio. A reversed clip starts at the end of its range and plays down to `sourceIn`.
- `start` omitted → append right after the last clip on the destination track (and the linked audio's track).
- `repeat: n` places n copies back to back. Refs are `ref`, `ref.2`, `ref.3`…
- The linked audio clip is reported (`+ linked audio c6 (v.audio)`) and named `ref.audio` (`ref.2.audio`…) for later ops; `audioTrackId` picks its track.

Each `add_clip`/`add_text` result shows the placed `[start, end)` in flicks.

```json
{"ops":[
  {"op":"add_clip","mediaId":"m1","start":0,"sourceIn":"m1:w1043.start-40ms","sourceOut":"m1:w1047.end+60ms","speed":1.25,"ref":"line"},
  {"op":"add_clip","mediaId":"m1","sourceIn":"m1:w1045.start","sourceOut":"m1:w1045.end","repeat":4,"ref":"stutter"},
  {"op":"set_param","clipId":"stutter.4.audio","propertyId":"volume","paramId":"gain","value":6},
  {"op":"add_clip","mediaId":"m1","sourceIn":"m1:s88","sourceOut":"m1:s88.end","reverse":true}
]}
```

**Speed belongs to the linked pair.** It is the Speed property (`speed`, plus a `reverse` toggle) of the pair's picture clip, and the linked audio follows it. `set_param`/`add_keyframe`/`add_property` for `speed` on either clip of a pair edit that one instance; the result says `(on linked c5; applies to both)`. Setting speed on a clip that has none adds the property where the UI would.

### Keyframes in bulk

- `add_keyframes {clipId, propertyId, paramId, keys:[{time, value, easing?}]}` sets many keyframes in one op.
- `wiggle {clipId, propertyId, paramId, amplitude, frequency, from?, to?, seed?, easing?}` adds random keyframes around the parameter's current (possibly animated) value. Use it for camera shake (`transform.position`, amplitude `[0.02,0.015]`, 12 Hz), rotation or scale jitter. The first and last keys sit on the original value so the wiggle blends in. `easing: "linear"` gives jitter, `"hold"` snappy jumps.

Font parameters must name an installed family; `registry_list` returns `fonts`. An unknown font is rejected with similar installed names, rather than silently falling back. `trim.time` is the desired absolute timeline edge. `propertyId` accepts an instance id or a property type (first instance if stacked). Use instance ids for stacked effects. An `add_property` ref can name the new instance for later operations.

Placement overwrites the destination range, matching UI behavior. Video source placement also creates linked audio when the media type requests it. Move, trim, split and delete respect linked clips. `ripple_delete` removes the interval across unlocked tracks, shifts later clips equally (including across gaps), and adjusts markers; locked tracks stay fixed. Operations that would alter a locked linked counterpart fail.

Validation runs every operation, including dependent refs and resulting document ranges, on an isolated copy using `app.edit.*`. Only a fully successful batch is committed with `doc.transact`; failure leaves the live project and history untouched. The core document store does not support nested transaction groups, so this avoids partial sequential edits and requires no core changes.

Failure example:

```text
Operation 2 (delete): Unknown clip does-not-exist; refresh timeline_get. No edits applied.
Recovery: inspect project_get, timeline_get or registry_list, correct the arguments, then retry.
```

## Editing by transcript

The analysis is the map for content edits. Agents can see exactly where words, sentences, pauses, fillers, stressed words, intonation, sound events and shot cuts sit on the timeline.

1. `media_analyze(mediaId)`, then poll `job_get`. Analysis runs once per source file and is cached. Every clip of that source benefits, whatever its trim or speed. See [analysis.md](analysis.md) for models and accuracy.
2. `transcript_get` returns timeline-time lines, interleaved chronologically:

```
s1 00:00:01.00–00:00:02.21 w1–w5 So, {um,} this is great.
  ⏸ 1.50s w5.end → w6.start
✂ 00:00:03.15
s2 00:00:04.06–00:00:05.03 w6–w7 [lively] ↗ *Really* great!
[APPLAUSE 00:00:05.09–00:00:07.00 .90]
```

   Legend:
   - `{um}` marks a filler.
   - `*word*` is stressed: pitch and loudness peak above the sentence's trend, at most one per sentence. It also marks words at least 6 dB louder than the median.
   - `_word_` is at least 16 dB quieter and may be hard to hear.
   - `word?` marks low recognizer confidence.
   - `[lively]` / `[flat]` mark unusually wide or narrow pitch variation for this speaker. `↗` marks a rising ending: a question, uncertainty, or a list that continues. These are measurements, not emotion labels.
   - A pause line names the anchors on either side, so `w5.end+80ms` → `w6.start-80ms` tightens it.
   - `(part)` means the sentence is partly trimmed out of the clip.
   - `view: "words"` lists every word with its id, timecode, pitch (semitones vs. the speaker's norm) and loudness (dB vs. the median).
3. Edit with the ordinary ops. Any time field can be an **anchor**, including `start`, `end`, `time`, keyframe times and `frame_get`:
   - **Forms:** `w12`, `w12.end`, `s3.start`, and offsets such as `w12.end+80ms`, `s3-0.5s` or `s3.end+2f` (frames).
   - **Resolution:** anchors resolve to exact word times, not frame-rounded timecodes. They resolve against the timeline as edited so far in the batch, so several word cuts in one batch stay correct.
   - **Keyframe times:** an anchor in a keyframe/parameter time is converted to clip-local time.
   - **Pieces:** if a clip was cut into pieces, earlier in the batch or before, a `split`, `add_keyframe` or `set_param` with an anchor time goes to the piece of the same source on the same track that holds that moment. The result line names the piece. So "cut the pauses, then punch in on w227" works in one batch with the original clip id.
   - **Cut ids:** an anchor whose word has already been cut is rejected, and nothing in the batch is applied.

   There are deliberately no special "remove fillers" or "tighten pauses" operations. You decide what to cut, how much padding to keep, and whether to punch in or cover a jump cut with b-roll. Then you compose it from `ripple_delete`, `split`, `trim`, `move`, properties and keyframes. Examples:
   - Remove a filler: `{"op":"ripple_delete","start":"w2.start-30ms","end":"w3.start-60ms"}`. This keeps the pause before it and doesn't clip the next word's attack.
   - Mark a reaction: `{"op":"add_marker","time":"s14.start","name":"applause"}`.
   - Punch in on a word: `add_keyframe` scale 1 at `w40.start-200ms` and 1.1 at `w40.start`, on the clip under it.
4. `transcript_search("phrase")` finds spoken phrases (case- and punctuation-insensitive), and `regex:true` matches sentence text. Results are word-id ranges usable as anchors.
5. **Read a source without placing it.** `transcript_get(mediaId)` / `transcript_search(query, mediaId)` work in source time. Their ids are source anchors numbered by position: `m1:w1043`, `m1:s88`, with the same `.start`/`.end`/offset forms. Use them in `add_clip` `sourceIn`/`sourceOut` to cut by sentence or word with no timecode arithmetic. Timeline fields reject source anchors, and vice versa.

The words view shows each word's start and end (`w12 00:00:04.06–00:00:04.18`). The same source words placed several times on a track (stutters) get distinct ids in timeline order.

`timeline_get` ends with a hint showing whether a transcript is available, or which sources to analyze.

## Listening: audio_check

`audio_check(start?, end?, transcribe = true)` renders the timeline audio for the range (at most 10 minutes) through the WAV exporter, exactly as an export would: speed, reverse, pitch, volume and other audio properties included. It then measures the render:

- the whole range: sample peak (dBFS), integrated loudness and loudest 400 ms (LUFS, BS.1770 K-weighted and gated), and clipped samples with their timecodes. There is a warning above -1 dBFS.
- per audio clip: the same readings for the mix while that clip plays.
- `transcribe`: the render is transcribed locally. The heard sentences are listed in timeline time, so a cut that clips a syllable shows up as a missing or garbled word.

It is asynchronous: `job_get(jobId, wait: 60)` returns the report when done. It runs one heavy job at a time and refuses to start while an export or analysis is running.

## Frames and sheets

`frame_get(time,width?)` returns a PNG image plus its timecode. Both dimensions are constrained to a maximum long edge of 1568px. `contact_sheet(start?,end?,count?|interval?,columns?)` and `timeline_preview_sheet(start?,end?,count?,columns?)` return **one JPEG grid**, at most 1568px on its long edge, with timecode labels and a cell → timecode/flicks mapping. Defaults are nine cells, three columns. Counts are bounded to 1–24; choose count or interval, not both. The end point is exclusive; the last evenly spaced frame sits before it. Timeline sheets capture a single project snapshot for consistency across cells.

`shots: true` (on `contact_sheet` and `media_contact_sheet`) puts one cell per shot instead of even spacing: the mid-shot frame, labeled with the shot's range. On a source the shots come from `media_analyze`; on the timeline they are shot cuts plus visual clip starts. Shots are taken from `start` (up to `count`, default 24), and the text says where to continue. Use it to see what is on screen in each shot (a person at a desk, a wallpaper, a chip graphic) and find visual gags. Cascade does no visual captioning itself; you describe what you see.

`media_contact_sheet(mediaId,…)` samples ffmpeg posters directly, without requiring a timeline clip. It works independently of the frame export service. Canvas images use anonymous CORS with the existing `media://` protocol so the returned JPEG remains readable.

## Writing effects

Call `plugin_api_docs` for the complete minimal working **Agent Glow** property plugin. `plugin_write(name,code)` writes a TypeScript entry through the existing user plugin bundler, returns compiler errors when present, and confirms the renderer hot reload before reporting success. Verify the contribution with `registry_list`, then add it with `add_property`.

User plugins bundle from userData; `@core/plugin-api` is not resolvable there. The example defines `definePlugin` as its identity helper locally, exports the standard plugin object, and registers a property whose `apply()` returns `PropertyOutput`. Spatial CSS comes from `ctx.u.len()`, `ctx.u.x()` and `ctx.u.y()`. No dependency or bundler change is needed. Build/activation/import failures return `isError` results; an unconfirmed import times out after ten seconds rather than claiming success. Plugin files are external to project history; removing a plugin does not erase its instances from the document.

## Verification and current limits

Run from the checkout:

```sh
npx tsc --noEmit -p tsconfig.json
npx electron-vite build
bun run test -- src/main/mcp/server.test.ts src/plugins/builtin/mcp/edits.test.ts
CASCADE_USER_DATA=/tmp/cascade-mcp-profile CASCADE_PROJECTS=/tmp/cascade-mcp-projects node scripts/drive.mjs /tmp/cascade-mcp-shots src/main/mcp/verify.mjs
```

`src/main/mcp/agent-editing.steps.mjs` drives the content-editing features end to end on `~/wwdc.webm`: source transcripts and anchors, linked speed, reverse, repeat/append, wiggle, font checks, shot sheets and `audio_check`. It needs the analysis models in the profile, e.g. `ln -s ~/.config/Cascade/models <profile>/models`.

The driver connects using the installed SDK, lists 30 tools, creates a project, imports `~/wwdc.webm`, adds an animated title, splits and ripple-deletes a range, verifies a failed batch is atomic, generates a real source sheet, writes the documented plugin and confirms registration, checks build failure reporting, undoes/redoes, tests authentication and disabling the setting, and connects a second SDK client through the stdio proxy. Unit tests also cover direct calls without initialization, tolerated legacy session headers, progress notifications and locked linked audio.

Artifacts: `/tmp/cascade-mcp-verification.txt`, `/tmp/cascade-mcp-shots/agent-edit.png`, `/tmp/cascade-mcp-source-sheet.jpg`, and `/tmp/cascade-mcp-contact-sheet-mock.jpg` when the real frame service is unavailable.

Export, frame/sheet and caption tools are all backed by real services now. `history_get` provides current undo/redo labels and the last observed change events, rather than exposing private core history stacks.
