# Cascade MCP

Cascade exposes **41 tools** that inspect and edit the project open in its editor. Edits appear immediately in preview and use the same editing APIs as the UI. A successful `timeline_apply_edits` batch is one undo step labeled `Agent: apply N edits` (or `Agent: split`, etc.). No additional packages are required: this implementation uses the installed `@modelcontextprotocol/sdk` v1 and Zod.

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

Calls execute in the renderer via the existing `mcp.onCall` / `mcp:reply` bridge. Main handles transport, authentication, validation and routing. Calls are serialized in the renderer. The forwarding timeout is three minutes; after a timeout inspect `timeline_get` / `history_list` before retrying (or retry with the same `requestId`) a mutation, since timeout does not cancel work already running in the editor. Calls with a progress token receive running/completed notifications; asynchronous export frame counts are retrieved through `job_get`.

## Agent workflow

1. Inspect `project_get`, `timeline_get`, and `registry_list`. If no project is open, use `project_new` or `project_open`. Save before replacing an open project.
2. See with `contact_sheet`: each cell is labeled with its time and clip, and its text names the visible clips (top first), the audio clips and the words spoken around it. `mediaId` samples a source before placing it. `frame_get` renders one frame (`guides: true` draws safe areas and element boxes).
3. Apply edits in batches with `timeline_apply_edits`: `dryRun: true` first, `requestId` so a retry can't apply twice, `ifRevision` against stale reads.
4. Check with `inspect_range` (lint + audio summary + a smart sheet with waveforms for the range you just edited), or `timeline_lint`, `audio_analyze` and `timeline_stats` separately. Undo mistakes with `history_undo`.
5. Save with `project_save`; export with `export_start`, wait with `job_get` (`wait` up to 120 s), and optionally `export_cancel`.

Agents can't watch playback. The sheets, the transcript, `audio_analyze` and `timeline_lint` are how they judge timing, and there is deliberately no video player.

**Times.** Every time field takes integer flicks (705600000 = one second), a clock time exactly as the tools print it (`00:01:23.500`, `1:23.5`; decimal seconds after the dot), or an amount with a unit (`83.5s`, `500ms`, `12f` for frames). Timeline fields also take transcript anchors, source fields source anchors. Tools print `HH:MM:SS.mmm` and, where exactness matters, flicks beside it. Keyframe times are clip-local; placement, split, trim, marker and range times are timeline time. Ranges are half open `[start,end)`. Spatial values are frame fractions; e.g. position `[0.25, 0]` is one quarter frame width right of center. Use `registry_list` to discover units, ranges and property definitions. Never put floating-point seconds or pixel lengths in the document.

Tools are listed in deterministic order and accept `detail: "concise" | "detailed"` (concise by default). `project_get` lists every timeline with its id, name, duration, active flag and referencing media items (the detailed project adds `timelineSummaries`). `timeline_get {timelineId?}` reads any timeline without changing the active timeline, playback, selection or undo history. `timeline_switch {timelineId}` is navigation outside undo; it pauses playback, restores the timeline's playhead and clears selection.

`timeline_get` filters with `trackId`, `mediaId`, `start`/`end` (clips overlapping the range), `query` (case-insensitive match on the clip name or its text) and `clipId` (that one clip with every parameter and keyframe); `format: "json"` returns the same as compact objects. Concise text starts with a header (including the **revision**) and a `user:` line (playhead, whether it's playing, selected clip ids), then one line per clip: id, times, `[start, end)` in flicks, source and source range, effective speed (`speed 2×`, `reversed`, `(from linked clip)`), `linked=` partner ids, and only the parameters that differ from their defaults. Both formats include track transitions (id, type, from/to, duration, alignment, params), timeline/clip markers (id, kind, name, time, duration, color, note), non-default track solo/gain/pan, and referenced timeline ids on composition clips. Trimmed-out clip markers have `time: null`, `trimmedOut: true` and their source coordinates in JSON; text labels them “trimmed out”. IDs such as `m1`, `c1`, `t1`, `p1`, `x1` (transition), `k1` (marker), `l1` (timeline) are stable aliases for the current editor lifetime; full document ids also work. A batch `ref` is a temporary name usable by later operations in that batch.

| Tools | Purpose |
| --- | --- |
| `project_get`, `project_new`, `project_open`, `project_save`, `project_settings_set` | Session and undoable project settings |
| `media_list`, `media_import`, `media_probe`, `media_relink` | Sources and undoable source relinking; paths must be absolute or `~/…` |
| `timeline_get`, `timeline_switch`, `timeline_apply_edits` | Inspect any timeline (filterable, text or JSON), navigate, and edit the active timeline |
| `playhead_get`, `playhead_set` | Where the user is (playhead, playing, selection, clips under the playhead); move the playhead and play/pause so the user sees a moment |
| `history_undo`, `history_redo`, `history_list` | Undo/redo `steps` at a time (including UI edits); labels, revision and recent change events |
| `registry_list`, `font_preview` | Media types, transitions, marker kinds, presets, timeline tools, property parameters (including path/curve shapes), easings, generators, exporters, installed fonts; `font_preview` renders families in their own faces |
| `frame_get`, `contact_sheet`, `shot_list` | See frames: one frame (with optional guides), labeled paged sheets of the timeline or a source, shots with motion/brightness/color |
| `audio_analyze`, `audio_normalize`, `silence_trim`, `beat_grid` | Measure the mix or a source; loudness-match clips; find and cut dead air; tempo and beats for `snap_to_beats` |
| `timeline_lint`, `timeline_stats`, `inspect_range` | Check the edit: issues with suggested fixes, pacing metrics (compare two cuts), one-call range review |
| `media_analyze`, `transcript_get`, `transcript_search` | Edit by content: words, fillers, pauses, loudness, pitch and stress, sound events and shot cuts. See [Editing by transcript](#editing-by-transcript) |
| `captions_generate`, `captions_from_script` | Whisper captions for a clip, a source or the whole timeline onto one track; timed captions from a script |
| `plugin_write`, `plugin_list`, `plugin_remove`, `plugin_api_docs` | Property plugin authoring and hot reload |
| `export_start`, `job_get`, `export_cancel` | Asynchronous jobs; `job_get(wait)` blocks until a job finishes (any job kind) |

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

Supported operations: `add_clip`, `add_text`, `move`, `trim`, `split`, `delete`, `ripple_delete`, `duplicate_clip`, `replace_clip`, `set_param`, `add_keyframe`, `add_keyframes`, `clear_keyframes`, `wiggle`, `add_property`, `remove_property`, `copy_properties`, `add_marker`, `add_track`, `remove_track`, `update_track`, `move_track`, `merge_tracks`, `duck`, `snap_to_beats`, `sync_text`, `add_transition`, `update_transition`, `remove_transition`, `ripple_trim`, `roll`, `slip`, `slide`, `close_gap`, `freeze_frame`, `update_marker`, `remove_marker`, `nest`, `break_apart`, `create_timeline`, `rename_timeline`, `delete_timeline`, `apply_preset`. Each operation has a strict schema in `tools/list`. A batch holds at most 300 operations.

### Batches: dry runs, revisions, removed clips

- `dryRun: true` runs the whole batch on the isolated copy and returns the per-operation results, then commits nothing.
- Every result ends with `revision N`; `project_get` and `timeline_get` report it too. It increases on every document change, from the agent or the user. Pass `ifRevision: N` to refuse a batch when the project changed since you read it.
- `requestId` makes a retry safe: a batch whose `requestId` was already applied returns the earlier result instead of applying again (the last 200 are remembered).
- Deleting a clip also deletes its linked partner, as in the UI. A later operation that names a clip an earlier one removed fails with `Clip c7 was already removed by operation 3 (delete c6)`.

### Styles and tracks

- `copy_properties {fromClipId, toClipIds, properties?, params?}` applies one clip's look (values and keyframes) to many: same-type properties are overwritten, missing ones added. A text clip's own words (`text.text`) and speed are never copied unless named. Style one caption, then copy it to the rest.
- `clear_keyframes {clipId, propertyId, paramId?, value?}` removes animation, leaving `value` or the value at the clip start.
- `duplicate_clip {clipId, start?, trackId?, ref?}` copies a clip (and its linked partner) with all properties; default right after it. `replace_clip {clipId, mediaId, sourceIn?}` swaps the source under a clip and keeps its timing, track, properties and link (linked audio goes if the new source is silent).
- `merge_tracks {trackIds, into}` moves the clips of several tracks onto one (later clips win overlaps) and removes the emptied tracks, e.g. after several caption runs.
- `add_track {kind, name?, index?, ref?}`, `remove_track {trackId}` (with its clips), `update_track {trackId, name?, locked?, muted?, hidden?, solo?, gain?, pan?}` and `move_track {trackId, index}`. `index` counts tracks of that kind in `timeline_get` order; later visual tracks draw on top, and a new visual track goes last (on top).

### Transitions, trim tools, markers and sequences

All clip/track/transition/marker operations in a batch target the **active timeline**. `create_timeline` does not switch. Use `timeline_switch` between batches to edit another timeline. If `delete_timeline` deletes the active timeline, subsequent operations target the surviving active timeline selected by the editing API. Registry IDs are open strings: third-party transitions, marker kinds, composition media types and property style presets are discovered with `registry_list` and checked against the live registries.

- `add_transition {type, from?, to?, duration?, align?, params?, ref?}` requires at least one clip edge. Two-sided transitions require adjacent clips on one track; the type must support its track kind. Alignment is `center` (default), `start` or `end`. Defaults, frame/handle clamping and parameter merging use the editing API. Linked picture/sound receive the first registered compatible audio transition when eligible; duration/alignment updates and deletion affect the paired transitions. `update_transition {transitionId, type?, duration?, align?, params?}` and `remove_transition {transitionId}` accept aliases or an earlier transition ref. Missing, incompatible or locked targets fail the batch.
- `ripple_trim {clipId, edge, time}` and `roll {clipId, edge, time}` take the desired absolute timeline edge/cut. `edge` is `start` or `end`; `roll` converts the target to the editing API's delta. `slip {clipId, delta}` and `slide {clipId, delta}` take signed integer flicks or signed unit amounts such as `-2s`, `+12f`, `500ms`. Slip deltas are timeline-local amounts integrated through the clip's time map. Linked partners follow by default. Source/adjacency limits clamp as in the UI; an edit blocked entirely fails with a reason.
- `close_gap {trackId, time}` closes the gap at that timeline time while preserving linked synchronization; absent or blocked gaps fail. `freeze_frame {clipId, time, duration?, ref?}` inserts a visual hold and a silent interval on linked audio. Time must be inside the clip. Omitted duration uses the editor's hold-duration setting (default two seconds). The ref names the inserted hold clip.
- `add_marker {time, name, kind?, color?, note?, duration?, clipId?, ref?}` creates a timeline marker or, with `clipId`, a clip marker. `update_marker {markerId, name?, kind?, color?, note?, duration?, time?}` and `remove_marker {markerId}` address either scope, including by ref. **Time always means timeline time**; add/move use the clip's time map to store source coordinates. Clip marker duration is source time; timeline marker duration is timeline time. Output gives clock times and exact flicks, plus clip markers' source positions. Unknown stored kinds remain readable; newly supplied kinds must be registered. Clip marker edits respect track locks.
- `update_track` also accepts `solo?: boolean`, `gain?: number` in dB (-60..12) and `pan?: number` (-1..1). Resetting gain/pan to zero or solo to false removes the stored override.
- `nest {clipIds, mediaType?, name?, ref?}` uses the registered `mediaType` (default `sequence`) and returns the composition clip. `break_apart {clipId}` restores its contents. Both report the editing API's refusal reason, including incompatible selection or composition effects/retiming. `create_timeline {name?, ref?}`, `rename_timeline {timelineId, name}` and `delete_timeline {timelineId}` are undoable batch primitives. Delete refuses the last timeline or one referenced by surviving composition clips.
- `apply_preset {clipIds, presetId}` accepts property style presets only. Currently `captions.style` is the registered property style kind: it uses the same `styleOverBase` → `app.edit.applyStyle` path as the caption UI, preserving each clip's words and resetting the style's base values. Third-party presets of that kind work; other kinds fail clearly.

`registry_list {only?: ["transitions", "markerKinds", "presets", "timelineTools", ...]}` exposes transition ids/names/kinds/params, marker kinds, preset ids/kinds/names/groups and timeline tool ids/names/keys alongside the existing sections. Property parameter definitions include `valueShape` for structured values:

```ts
// path: fractions of the untransformed content box; in/out are relative tangents.
{ closed: boolean, points: { x: number, y: number, in?: [number, number], out?: [number, number] }[] }
// curve: normalized input/output point pairs on each channel.
{ master: [number, number][], r: [number, number][], g: [number, number][], b: [number, number][] }
```

Pass these objects as `set_param.value` using the actual property/param ids from the registry. See [masks.md](masks.md) for geometry and interpolation details.

`media_relink {mediaId, path}` re-probes an absolute or `~/…` replacement path through `app.edit.relinkMedia`, clears the old proxy, and commits one undo step. It returns the new metadata (clock duration plus `durationFlicks`) or the probe error. Concurrent user changes while probing cause the relink to fail without replacing those changes.

### Audio, music and text timing

- `duck {clipIds, amount = -12, attack?, release?, mergeGap?}` keyframes the clips' volume down wherever the transcript has speech (words of the ducked clips themselves don't count). It needs `media_analyze` on the speech sources; clips with volume keyframes are refused.
- `snap_to_beats {clipIds, beatClipId, to: beats|downbeats, edge: start|end, maxShift = 250ms, keyframes = false}` moves clip starts (or trims ends, or moves keyframes) to the nearest beat of a music clip that `beat_grid` analyzed. Clips farther than `maxShift` stay put and are counted.
- `sync_text {clipIds, padding?}` retimes text clips to when their words are spoken: the transcript run nearest the clip that matches its text, tolerating a filler between words.

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
s1 00:00:01.000–00:00:02.700 w1–w5 So, {um,} this is great.
  ⏸ 1.50s w5.end → w6.start
✂ 00:00:03.500
s2 00:00:04.200–00:00:05.100 w6–w7 [lively] ↗ *Really* great!
[APPLAUSE 00:00:05.300–00:00:07.000 .90]
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
   - **Resolution:** anchors resolve to exact word times. They resolve against the timeline as edited so far in the batch, so several word cuts in one batch stay correct.
   - **Keyframe times:** an anchor in a keyframe/parameter time is converted to clip-local time.
   - **Pieces:** if a clip was cut into pieces, earlier in the batch or before, a `split`, `add_keyframe` or `set_param` with an anchor time goes to the piece of the same source on the same track that holds that moment. The result line names the piece. So "cut the pauses, then punch in on w227" works in one batch with the original clip id.
   - **Cut ids:** an anchor whose word has already been cut is rejected, and nothing in the batch is applied.

   There are deliberately no special "remove fillers" or "tighten pauses" operations. You decide what to cut, how much padding to keep, and whether to punch in or cover a jump cut with b-roll. Then you compose it from `ripple_delete`, `split`, `trim`, `move`, properties and keyframes. Examples:
   - Remove a filler: `{"op":"ripple_delete","start":"w2.start-30ms","end":"w3.start-60ms"}`. This keeps the pause before it and doesn't clip the next word's attack.
   - Mark a reaction: `{"op":"add_marker","time":"s14.start","name":"applause"}`.
   - Punch in on a word: `add_keyframe` scale 1 at `w40.start-200ms` and 1.1 at `w40.start`, on the clip under it.
4. `transcript_search("phrase")` finds spoken phrases (case- and punctuation-insensitive), `any: true` matches any of several keywords, and `regex: true` matches sentence text; `start`/`end` limit the range and `offset`/`limit` page the hits. Results are word-id ranges usable as anchors. Long transcripts page too: `transcript_get` says `Continue with offset=N`.
5. **Read a source without placing it.** `transcript_get(mediaId)` / `transcript_search(query, mediaId)` work in source time. Their ids are source anchors numbered by position: `m1:w1043`, `m1:s88`, with the same `.start`/`.end`/offset forms. Use them in `add_clip` `sourceIn`/`sourceOut` to cut by sentence or word with no timecode arithmetic. Timeline fields reject source anchors, and vice versa.

The words view shows each word's start and end (`w12 00:00:04.200–00:00:04.600`). The same source words placed several times on a track (stutters) get distinct ids in timeline order.

`timeline_get` ends with a hint showing whether a transcript is available, or which sources to analyze.

## Listening: audio_analyze

`audio_analyze(start?, end?, mediaId?, clipIds?, transcribe = false, waveform = false, format = text|json, wait = 60)` measures the timeline mix for the range (at most 10 minutes), rendered through the WAV exporter exactly as an export would (speed, reverse, pitch, volume and other audio properties included), or a source's audio with `mediaId`:

- the whole range: sample peak and RMS (dBFS), integrated loudness and loudest 400 ms (LUFS, BS.1770 K-weighted and gated), clipped samples with their times, and the channel layout (stereo, mono on both channels, one side only). There is a warning above -1 dBFS.
- speech and music share of the range, from `media_analyze` (words and music events).
- the shape: a loudness strip (one character per 0.25 s or more, space = silence, `▁` -60 … `█` -12 LUFS) and the silent stretches of 0.5 s or longer, so a beat before a punchline, a dead gap or music swelling over a line shows up.
- per audio clip: the mix while it plays and the clip's **own source level**, flagged `SILENT` when its source range has nothing audible (a wrong `sourceIn`, a muted gain).
- `transcribe`: the render is transcribed locally and the heard sentences are listed, so a cut that clips a syllable shows up as a missing or garbled word. `waveform` adds a loudness envelope PNG with -14/-23 LUFS guides.

It waits up to `wait` seconds, else returns a jobId for `job_get`. It runs one heavy job at a time and refuses to start while an export or analysis is running.

- `audio_normalize {clipIds, target = -16, dryRun}` measures each audio clip's source loudness and sets its volume so it plays at `target` LUFS, in one undo step; keyframed volumes are skipped.
- `silence_trim {start, end, threshold = -45, minSilence = 700ms, keep = 150ms, apply}` lists stretches of the mix quieter than `threshold`; `apply: true` ripple-deletes them (later first, one undo step) across unlocked tracks, so lock a music bed's track to keep it whole.
- `beat_grid {clipId | mediaId, start?, end?, minBpm, maxBpm}` estimates tempo, beats, downbeats and onsets (spectral-flux onsets, autocorrelated tempo, then a beat-tracking pass; downbeats assume 4/4). With `clipId` the times are timeline times and `snap_to_beats` can use them.

## Checking the edit

`timeline_lint {start?, end?, rules?, audio = true, frames = true}` returns JSON issues (`rule`, `severity`, time range, clip ids, `message`, `suggestedFix` phrased as edit ops). Rules: `safe-area` (text outside the 90% title-safe area), `text-overflow`, `text-overlap`, `reading-speed` (over 20 characters/s), `text-dwell`, `silent-clip`, `clipping`, `dead-air`, `missing-linked-audio`, `black-frame`, `freeze`, `cut-rhythm`, `repeated-media`, `gap`. `audio` renders the mix and decodes clip sources; `frames` samples the picture at 2 per second (at most 240). Turn both off for a quick layout check.

`timeline_stats {compareTo?}`: duration, shots and average/median/longest shot, cuts per minute, speech coverage, words per minute, fillers, music coverage, text on screen, captions, gaps and tracks. `compareTo` loads another `.cascade` file and adds deltas, to compare two cuts.

`inspect_range {start, end, preview = false}` is the "what did I just do" call: lint issues, the audio summary and a 12-cell smart sheet with waveforms for the range, from one mix render. `preview` also exports a 640 px MP4 to `<userData>/previews` for the user to watch.

## Frames and sheets

`frame_get(time, width?, guides?)` returns a PNG plus its time. `guides` draws the action-safe (95%) and title-safe (90%) areas and every visible element/text box with its clip id, and lists the boxes in frame fractions.

`contact_sheet` covers the timeline or, with `mediaId`, a source (ffmpeg posters, no timeline clip needed):

- **Spacing:** `count` (1–200), `interval` (`0.5s`, flicks…) or `fps` (cells per second). `mode: "shots"` puts one cell per shot (mid-shot frame, labeled with the shot's range; shots come from `media_analyze` cuts plus visual clip edges). `mode: "smart"` takes the first frame after each cut, each shot's middle and an even baseline, thinned to `count` (default 24).
- **Pages:** up to 30 cells per JPEG, each at most 1568 px on its long edge; more cells come back as several images. `columns` defaults to 3 up to 9 cells, then 6.
- **Labels:** each cell shows its number, time and (timeline) the top clip's name. `labels: false` drops them.
- **Audio:** `audio: true` draws a waveform strip under each cell and reports its loudness (the rendered mix, or the source's own audio).
- **Flags:** black, `static` (no visible change from the previous cell; normal for a held shot, worth a look when it should move), silent, `text-overflow`, `outside-safe-area` and `text-overlap` cells are flagged on the image and in the data.
- **Format:** `sheet` (images plus one line per cell: visible clips, audio clips, the words within ±1.5 s with the current one in `«»`), `json` (no images: per cell time, clips, words, loudness, luma, change, flags) or `both`.

`shot_list(start?, end?, mediaId?)` returns shots as JSON: start, end, length, visible clips, motion (0–1, picture change within the shot), brightness and average color, plus average/median shot length. Cascade does no visual captioning, OCR or face detection; you describe what you see on the sheets.

`font_preview(families? | query?, text?, weight?)` returns one JPEG with each family drawn in its own face (bundled and installed system fonts, at most 24), so a font can be chosen by look rather than name.

## Captions

`captions_generate {scope, clipId?, mediaId?, language?, trackId?, replace = true, style?}` transcribes with Whisper into word-timed caption clips. `scope: "clip"` captions one clip (or a source placed at the playhead); `scope: "timeline"` captions every clip with sound, in time order, all onto one track. `trackId` targets an existing track and `replace` clears what it holds in the captioned range first; `style` overrides the default look, e.g. `{"transform":{"position":[0,0.38]},"text":{"size":0.04}}`. Asynchronous: poll `job_get`. See [captions.md](captions.md).

`captions_from_script {script, start?, end?, trackId?, replace, style?}` turns a script into timed captions without Whisper: each line (or blank-line-separated block) becomes a caption spanning the transcript words it matches, in order. Unmatched lines are reported. Retime existing text clips with the `sync_text` op instead.

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

`src/main/mcp/agent-editing.steps.mjs` drives the content-editing features end to end on `~/wwdc.webm`: source transcripts and anchors, linked speed, reverse, repeat/append, wiggle, font checks, shot sheets and `audio_analyze`. It needs the analysis models in the profile, e.g. `ln -s ~/.config/Cascade/models <profile>/models`.

The driver connects using the installed SDK, lists 39 tools, creates a project, imports `~/wwdc.webm`, adds an animated title, splits and ripple-deletes a range, verifies a failed batch is atomic, generates a real source sheet, writes the documented plugin and confirms registration, checks build failure reporting, undoes/redoes, tests authentication and disabling the setting, and connects a second SDK client through the stdio proxy. Unit tests also cover direct calls without initialization, tolerated legacy session headers, progress notifications and locked linked audio.

Artifacts: `/tmp/cascade-mcp-verification.txt`, `/tmp/cascade-mcp-shots/agent-edit.png`, `/tmp/cascade-mcp-source-sheet.jpg`, and `/tmp/cascade-mcp-contact-sheet-mock.jpg` when the real frame service is unavailable.

`history_list` provides current undo/redo labels and the last observed change events, rather than exposing private core history stacks.
