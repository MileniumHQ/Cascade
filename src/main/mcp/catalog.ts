/** Shared, browser-safe tool schemas. Transport and renderer validate the same contract. */
import { z } from 'zod'
const id = z.string().min(1).max(256)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Integer flicks (705600000 per second), never seconds')
const positiveTime = time.refine(v => v > 0, 'Must be positive')
/** Human time: a clock time as tools print it (HH:MM:SS.mmm or MM:SS.s, decimal seconds) or an amount with a unit (83.5s, 500ms, 12f). */
export const TIME_TEXT = /^(?:(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?|(\d+(?:\.\d+)?)(ms|s|f))$/
const timeText = z.string().regex(TIME_TEXT, 'Expected flicks, a time like 00:01:23.500 or seconds like 83.5s / 500ms / 12f')
const length = z.union([positiveTime, timeText]).describe('Positive integer flicks or an amount like 2s / 500ms / 12f')
export const signedLength = z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[+-]?\d+(?:\.\d+)?(?:ms|s|f)$/, 'Expected signed integer flicks or an amount like -2s / +12f / 500ms')]).describe('Signed integer flicks or a signed unit amount; linked partners follow')
const clock = z.union([time, timeText]).describe('Integer flicks, a time as tools print it (00:01:23.500) or an amount like 83.5s / 500ms / 12f')
/** Word/sentence anchor from transcript_get: w12, w12.end, s3.start, w12.end+80ms, s3-0.5s. */
export const ANCHOR = /^([ws]\d+)(?:\.(start|end))?(?:([+-])(\d+(?:\.\d+)?)(ms|s|f))?$/
const at = z.union([time, timeText, z.string().regex(ANCHOR, 'Expected flicks, a time (00:01:23.500), seconds (83.5s) or an anchor like w12, w12.end, s3.start, w12.end+80ms')])
  .describe('Integer flicks, a time (00:01:23.500), an amount (83.5s, 500ms, 12f), or a transcript anchor: w12 / w12.end / s3.start, optional offset +80ms / -0.5s / +2f (frames). Anchors resolve against the edits so far in this batch.')
/** Source anchor from transcript_get(mediaId): m1:w12, m1:s3.end, m1:w12.start-80ms (source time). */
export const SOURCE_ANCHOR = /^([^:\s]+):([ws]\d+)(?:\.(start|end))?(?:([+-])(\d+(?:\.\d+)?)(ms|s|f))?$/
const sourceAt = z.union([time, timeText, z.string().regex(SOURCE_ANCHOR, 'Expected source flicks, a source time (00:10:02.170), seconds (602.2s) or a source anchor like m1:w12, m1:s3.end-80ms')])
  .describe('Source time: flicks, a time / seconds (00:10:02.170, 602.2s), or a source anchor from transcript_get/transcript_search with mediaId: m1:w12 / m1:s3.start / m1:w12.end+80ms')
const detail = z.enum(['concise', 'detailed']).default('concise')
const dimensions = z.number().int().min(16).max(8192)
export const settingsSchema = z.object({ width: dimensions.optional(), height: dimensions.optional(), fps: z.object({ num: z.number().int().positive().max(240000), den: z.number().int().positive().max(10000) }).optional(), sampleRate: z.number().int().min(8000).max(192000).optional(), background: z.string().max(128).optional() }).strict()
const placement = {
  start: at.optional().describe('Timeline start. Omit to append right after the last clip on the destination track(s)'),
  duration: length.optional(),
  trackId: id.optional(),
  ref: id.optional()
}
const trackFlags = { name: z.string().min(1).max(100).optional(), locked: z.boolean().optional(), muted: z.boolean().optional(), hidden: z.boolean().optional(), solo: z.boolean().optional(), gain: z.number().min(-60).max(12).optional().describe('Track gain in dB'), pan: z.number().min(-1).max(1).optional() }
const keyValue = z.unknown().describe('Parameter value (numbers, [x,y] frame fractions, strings, booleans)')
export const editSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_clip'), mediaId: id, ...placement,
    duration: length.optional().describe('Timeline duration. Omit to derive it from sourceOut (default: end of source) and speed'),
    sourceIn: sourceAt.optional().describe('Where the clip starts in the source (default 0): source flicks or a source anchor like m1:w12.start-40ms'),
    sourceOut: sourceAt.optional().describe('Where the clip ends in the source (exclusive); the timeline duration becomes (sourceOut − sourceIn) / speed. Give duration or sourceOut, not both'),
    speed: z.number().min(0.05).max(16).optional().describe('Constant speed, applied to the clip and its linked audio'),
    reverse: z.boolean().optional().describe('Play the source range backwards (picture and linked audio)'),
    repeat: z.number().int().min(1).max(64).optional().describe('Place this many copies back to back (refs: ref, ref.2, ref.3…)'),
    audioTrackId: id.optional().describe('Track for the linked audio clip (default: first unlocked audio track)')
  }).strict(),
  z.object({ op: z.literal('add_text'), text: z.string().max(10000), ...placement, duration: length.optional().describe('Default 5 s') }).strict(),
  z.object({ op: z.literal('move'), clipId: id, start: at, trackId: id.optional() }).strict(),
  z.object({ op: z.literal('trim'), clipId: id, edge: z.enum(['start', 'end']), time: at }).strict(),
  z.object({ op: z.literal('split'), clipId: id, time: at, ref: id.optional() }).strict(),
  z.object({ op: z.literal('delete'), clipId: id }).strict(),
  z.object({ op: z.literal('ripple_delete'), start: at, end: at }).strict(),
  z.object({ op: z.literal('set_param'), clipId: id, propertyId: id.describe('Instance id or property type, e.g. transform'), paramId: id, value: z.unknown(), time: at.optional().describe('Clip-local integer flicks, or an anchor (converted to clip-local)') }).strict(),
  z.object({ op: z.literal('add_keyframe'), clipId: id, propertyId: id, paramId: id, time: at.describe('Clip-local integer flicks, or an anchor (converted to clip-local)'), value: z.unknown(), easing: id.optional() }).strict(),
  z.object({ op: z.literal('add_property'), clipId: id, type: id, ref: id.optional() }).strict(),
  z.object({ op: z.literal('remove_property'), clipId: id, propertyId: id }).strict(),
  z.object({ op: z.literal('add_marker'), time: at, name: z.string().max(1000), kind: id.optional(), color: z.string().max(128).optional(), note: z.string().max(10000).optional(), duration: length.optional(), clipId: id.optional().describe('Clip marker; time is timeline time, duration is source time'), ref: id.optional() }).strict(),
  z.object({ op: z.literal('update_marker'), markerId: id, name: z.string().max(1000).optional(), kind: id.optional(), color: z.string().max(128).optional(), note: z.string().max(10000).optional(), duration: length.optional(), time: at.optional().describe('Timeline time, including for clip markers') }).strict(),
  z.object({ op: z.literal('remove_marker'), markerId: id }).strict(),
  z.object({ op: z.literal('add_transition'), type: id, from: id.optional(), to: id.optional(), duration: length.optional(), align: z.enum(['center', 'start', 'end']).optional(), params: z.record(z.string(), z.unknown()).optional(), ref: id.optional() }).strict().describe('At least one of from/to. Adjacent linked picture/sound also receive the first registered audio transition, as in app.edit.addTransition'),
  z.object({ op: z.literal('update_transition'), transitionId: id, type: id.optional(), duration: length.optional(), align: z.enum(['center', 'start', 'end']).optional(), params: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ op: z.literal('remove_transition'), transitionId: id }).strict(),
  z.object({ op: z.literal('ripple_trim'), clipId: id, edge: z.enum(['start', 'end']), time: at }).strict(),
  z.object({ op: z.literal('roll'), clipId: id, edge: z.enum(['start', 'end']), time: at }).strict().describe('Desired absolute timeline cut; linked partners follow'),
  z.object({ op: z.literal('slip'), clipId: id, delta: signedLength }).strict(),
  z.object({ op: z.literal('slide'), clipId: id, delta: signedLength }).strict(),
  z.object({ op: z.literal('close_gap'), trackId: id, time: at }).strict(),
  z.object({ op: z.literal('freeze_frame'), clipId: id, time: at, duration: length.optional(), ref: id.optional() }).strict(),
  z.object({ op: z.literal('nest'), clipIds: z.array(id).min(1).max(500), mediaType: id.default('sequence'), name: z.string().min(1).max(200).optional(), ref: id.optional() }).strict(),
  z.object({ op: z.literal('break_apart'), clipId: id }).strict(),
  z.object({ op: z.literal('create_timeline'), name: z.string().min(1).max(200).optional(), ref: id.optional() }).strict().describe('Create without switching; clip ops always target the active timeline'),
  z.object({ op: z.literal('rename_timeline'), timelineId: id, name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ op: z.literal('delete_timeline'), timelineId: id }).strict(),
  z.object({ op: z.literal('apply_preset'), clipIds: z.array(id).min(1).max(500), presetId: id }).strict().describe('Apply a registered property style preset; other preset kinds are rejected'),
  z.object({ op: z.literal('clear_keyframes'), clipId: id, propertyId: id, paramId: id.optional().describe('Default: every parameter of the property'), value: z.unknown().optional().describe('Static value afterwards (default: the value at the clip start)') }).strict(),
  z.object({
    op: z.literal('copy_properties'), fromClipId: id, toClipIds: z.array(id).min(1).max(500),
    properties: z.array(id).max(50).optional().describe('Property types or instance ids to copy (default: all except speed)'),
    params: z.array(id).max(50).optional().describe('Only these parameter ids (e.g. ["position","size"]); default every parameter. text.text is never copied unless listed')
  }).strict().describe('Apply one clip\'s look (values and keyframes) to other clips: same-type properties are overwritten, missing ones are added'),
  z.object({ op: z.literal('add_track'), kind: z.enum(['visual', 'audio']), name: z.string().min(1).max(100).optional(), index: z.number().int().min(0).optional().describe('Position among tracks of that kind in timeline_get order, 0 = first; later visual tracks draw on top. Default: last (a new visual track draws over the others)'), ref: id.optional() }).strict(),
  z.object({ op: z.literal('remove_track'), trackId: id }).strict().describe('Delete a track and its clips (linked partners elsewhere go too, as in the UI)'),
  z.object({ op: z.literal('update_track'), trackId: id, ...trackFlags }).strict(),
  z.object({ op: z.literal('move_track'), trackId: id, index: z.number().int().min(0).describe('New position among tracks of its kind in timeline_get order, 0 = first; later visual tracks draw on top') }).strict(),
  z.object({ op: z.literal('duplicate_clip'), clipId: id, start: at.optional().describe('Default: right after the clip'), trackId: id.optional(), ref: id.optional() }).strict().describe('Copy a clip (and its linked partner) with all properties to a new time/track'),
  z.object({ op: z.literal('replace_clip'), clipId: id, mediaId: id, sourceIn: sourceAt.optional().describe('Default: the clip\'s current sourceIn') }).strict().describe('Swap the source under a clip, keeping its timing, track, properties and linked audio'),
  z.object({ op: z.literal('merge_tracks'), trackIds: z.array(id).min(1).max(50), into: id }).strict().describe('Move every clip of trackIds onto track into (later clips win overlaps) and remove the emptied tracks, e.g. several Captions tracks into one'),
  z.object({
    op: z.literal('duck'), clipIds: z.array(id).min(1).max(200).describe('Music/bed audio clips to lower'),
    amount: z.number().min(-60).max(0).default(-12).describe('dB under speech, relative to the clip\'s current gain'),
    attack: length.optional().describe('Fade down before speech (default 150ms)'), release: length.optional().describe('Fade up after speech (default 400ms)'),
    mergeGap: length.optional().describe('Speech gaps shorter than this stay ducked (default 800ms)')
  }).strict().describe('Sidechain-style ducking: volume keyframes that dip the clips wherever the transcript has speech (needs media_analyze on the speech sources)'),
  z.object({
    op: z.literal('snap_to_beats'), clipIds: z.array(id).min(1).max(500), beatClipId: id.describe('Music clip that beat_grid analyzed'),
    to: z.enum(['beats', 'downbeats']).default('beats'), edge: z.enum(['start', 'end']).default('start').describe('start moves the clip; end trims its end'),
    maxShift: length.optional().describe('Leave clips farther than this from a beat (default 250ms)'), keyframes: z.boolean().default(false).describe('Also snap the clips\' keyframes to beats')
  }).strict(),
  z.object({ op: z.literal('sync_text'), clipIds: z.array(id).min(1).max(500), padding: length.optional().describe('Kept before the first and after the last word (default 0)') }).strict().describe('Retime text clips to when their words are spoken (transcript match near the clip)'),
  z.object({ op: z.literal('add_keyframes'), clipId: id, propertyId: id, paramId: id, keys: z.array(z.object({ time: at.describe('Clip-local integer flicks, or an anchor (converted to clip-local)'), value: keyValue, easing: id.optional() }).strict()).min(1).max(1000) }).strict(),
  z.object({
    op: z.literal('wiggle'), clipId: id, propertyId: id, paramId: id,
    amplitude: z.union([z.number().nonnegative(), z.tuple([z.number().nonnegative(), z.number().nonnegative()])]).describe('Largest offset from the current value; [x,y] for vec2 params (frame fractions for position)'),
    frequency: z.number().min(0.1).max(60).describe('Random keyframes per second'),
    from: at.optional().describe('Clip-local start (default 0); anchors convert to clip-local'),
    to: at.optional().describe('Clip-local end (default clip end)'),
    seed: z.number().int().optional(),
    easing: id.optional().describe('Default ease-in-out (smooth wobble); linear for jitter, hold for snappy jumps')
  }).strict()
])
export type Edit = z.infer<typeof editSchema>
const range = { start: at.optional(), end: at.optional() }
const sourceRange = { start: clock.optional().describe('With mediaId: source time'), end: clock.optional() }
const captionStyle = z.record(z.enum(['transform', 'size', 'text', 'shadow']), z.record(z.string(), z.unknown())).optional().describe('Parameter values by property, e.g. {"transform":{"position":[0,0.38]},"size":{"size":[0.8,0.12]},"text":{"size":0.04,"font":"Inter","color":"#ffee00"}}; see registry_list for parameters')
const format = z.enum(['text', 'json']).default('text')
const tool = <T extends z.ZodRawShape>(name: string, description: string, shape: T, readOnly = true, destructive = false) => ({ name, description, schema: z.object({ ...shape, detail }).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: !readOnly } })
export const tools = [
  tool('project_get', 'Inspect the open project, settings, tracks, duration, revision and every timeline with referencing media. Start here.', {}),
  tool('project_new', 'Create a project through the editor session (written on the first edit or project_save). Replaces the open project; save first.', { name: z.string().min(1).max(200), settings: settingsSchema.optional() }, false, true),
  tool('project_open', 'Open an absolute .cascade file through the editor session. Save current work first.', { path: id }, false, true),
  tool('project_save', 'Save the current project to its path without dialogs.', {}, false),
  tool('project_settings_set', 'Set project reference resolution, frame rate or background. Undoable.', { settings: settingsSchema }, false),
  tool('media_list', 'List imported sources with short ids, types and durations.', {}),
  tool('media_import', 'Import absolute file paths (or ~/ paths). Returns source ids; does not add timeline clips.', { paths: z.array(id).min(1).max(100) }, false),
  tool('media_relink', 'Relink a source to an absolute file path (or ~/path), re-probe it and return its new metadata. Undoable.', { mediaId: id, path: id }, false),
  tool('media_probe', 'Probe a file without importing it.', { path: id }),
  tool('timeline_get', 'Read the active timeline or timelineId without switching, including transitions, timeline/clip markers, mix settings and composition references. text (default): one line per clip with id, times, type, name, source range, speed, linked clip and non-default properties, plus markers and the revision. json: the same as compact objects with resolved properties. Filter by trackId, mediaId, start/end (clips overlapping), query (clip name or text, case-insensitive) or clipId (one clip with every parameter and keyframe). detailed adds every property value.', { timelineId: id.optional(), trackId: id.optional(), mediaId: id.optional(), clipId: id.optional(), ...range, query: z.string().min(1).max(200).optional(), format }),
  tool('timeline_switch', 'Switch the active timeline. Navigation outside undo; pauses playback and restores its playhead.', { timelineId: id }, false),
  tool('playhead_get', 'Where the user is: playhead time, whether it is playing, selected clips, and the clips under the playhead with clip-local and source times. Use it to resolve "here", "this clip", "this shot".', {}),
  tool('playhead_set', 'Move the editor playhead (snapped to a frame) so the user sees that moment, and optionally start or stop playback.', { time: at.optional(), play: z.boolean().optional().describe('true starts playback from the playhead, false pauses') }, false),
  tool('timeline_apply_edits', 'Validate the whole batch on a copy, then commit one undo step. Clip ops target the active timeline. Primitives include transitions (linked audio follows app.edit.addTransition), ripple_trim, roll, slip/slide (signed deltas), close_gap, freeze_frame, markers, nesting, timeline structure and property style presets. ref names a result for later ops in the batch; add_clip also names its linked audio ref.audio (repeats ref.2, ref.2.audio…). Omit start to append after the last clip on the track. add_clip takes a source range (sourceIn/sourceOut: time or source anchors m1:w12) plus speed/reverse and derives the duration. Speed lives on the linked pair. Placement overwrites overlaps; split/delete/move include linked audio, and deleting a clip deletes its linked partner. ripple_delete removes a range on all unlocked tracks. Timeline times may be transcript anchors (w12.end+80ms) that re-resolve after each op. Bulk/style: add_keyframes, wiggle, copy_properties (apply one clip\'s look to many), clear_keyframes, duplicate_clip, replace_clip. Tracks: add_track, remove_track, update_track (rename, mute, lock, hide, solo, gain dB, pan), move_track, merge_tracks. Audio/music: duck, snap_to_beats (after beat_grid). Text: sync_text. At most 300 ops per batch. dryRun validates and reports without committing. ifRevision refuses the batch if the project changed since that revision. requestId makes a retry safe: a batch with a requestId already applied returns the earlier result instead of applying twice.', { ops: z.array(editSchema).min(1).max(300), dryRun: z.boolean().default(false), ifRevision: z.number().int().nonnegative().optional(), requestId: z.string().min(1).max(200).optional() }, false, true),
  tool('history_undo', 'Undo the latest document edits (including edits made in the UI).', { steps: z.number().int().min(1).max(50).default(1) }, false, true),
  tool('history_redo', 'Redo undone document edits.', { steps: z.number().int().min(1).max(50).default(1) }, false, true),
  tool('history_list', 'Undo/redo availability and labels, the current revision, and recent edit events (agent or user).', {}),
  tool('registry_list', 'Discover media types, transitions, markerKinds, presets, timelineTools, property parameter defaults/types/units/ranges and path/curve value shapes, easings, generators, exporters and installed fonts (font params must name one of them). only limits the sections; fontQuery filters fonts by name. See fonts with font_preview.', { only: z.array(z.enum(['mediaTypes', 'properties', 'easings', 'generators', 'exporters', 'fonts', 'transitions', 'markerKinds', 'presets', 'timelineTools'])).min(1).optional(), fontQuery: z.string().min(1).max(100).optional() }),
  tool('font_preview', 'See fonts: ONE JPEG specimen with each family rendered in its own face (bundled and installed system fonts). Pass families from registry_list fonts, or query to match names.', { families: z.array(z.string().min(1).max(200)).max(24).optional(), query: z.string().min(1).max(100).optional(), text: z.string().min(1).max(80).optional().describe('Sample text (default: a pangram with digits)'), weight: z.number().int().min(100).max(900).default(400) }),
  tool('frame_get', 'Render one timeline frame as a PNG. guides draws the title-safe (90%) and action-safe (95%) areas and every visible element/text box with its clip id.', { time: at, width: z.number().int().min(64).max(1568).default(960), guides: z.boolean().default(false) }),
  tool('contact_sheet', 'See a range as labeled JPEG sheets: the timeline (default) or a source (mediaId), without placing it. Spacing: count (1–200), interval, or fps; mode even (default), shots (one cell per shot, mid-shot frame) or smart (cuts + shot midpoints + an even baseline). Up to 30 cells per image; more cells come back as several images. Each cell is labeled with its time (and clip name on the timeline); audio adds a waveform strip under each cell; flags marks black, static (no visible change from the previous cell), silent and overflowing-text cells. format: sheet (images + one line per cell), json (per-cell data only, no images: time, clips, track, words, loudness, luma, flags) or both.', {
    mediaId: id.optional(), ...range,
    count: z.number().int().min(1).max(200).optional(), interval: length.optional(), fps: z.number().min(0.05).max(10).optional().describe('Cells per second of the range'),
    mode: z.enum(['even', 'shots', 'smart']).default('even'), columns: z.number().int().min(1).max(10).optional().describe('Default 3 up to 9 cells, then up to 6'),
    labels: z.boolean().default(true), audio: z.boolean().default(false).describe('Waveform strip and loudness per cell (renders the mix; sources decode their audio)'),
    flags: z.boolean().default(true), format: z.enum(['sheet', 'json', 'both']).default('sheet')
  }),
  tool('shot_list', 'Shots of the timeline (visual clip boundaries and analysis cuts) or of a source (mediaId, needs media_analyze): JSON with start, end, duration, clips, motion (0–1, frame change within the shot), brightness and average color. Look at them with contact_sheet mode=shots.', { mediaId: id.optional(), ...range }),
  tool('plugin_write', 'Write executable trusted property plugin TypeScript, compile and wait for renderer hot reload. Read plugin_api_docs first. This grants local application code execution.', { name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100), code: z.string().min(1).max(200000) }, false, true),
  tool('plugin_list', 'List user plugins, compile errors and activation status.', {}),
  tool('plugin_remove', 'Remove a user plugin from disk and hot unload it. Existing document instances remain preserved.', { name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100) }, false, true),
  tool('plugin_api_docs', 'Concise property plugin authoring contract and a working import-free example that loads from userData.', {}),
  tool('export_start', 'Start an asynchronous export; poll job_get. Output is an absolute path. Discover exporter ids with registry_list.', { exporter: id, start: clock.optional(), end: clock.optional(), width: dimensions.optional(), height: dimensions.optional(), output: id, options: z.record(z.string(), z.unknown()).default({}) }, false, true),
  tool('job_get', 'Progress and result of an asynchronous job (export, analysis, captions, audio_analyze, inspect_range preview). wait (seconds) blocks until it finishes or the wait elapses.', { jobId: id, wait: z.number().int().min(0).max(120).default(0) }),
  tool('export_cancel', 'Cancel an export job.', { jobId: id }, false, true),
  tool('media_analyze', 'Analyze a source locally so you can edit by content: verbatim words with timings (incl. um/uh), sentences, pauses, per-word loudness and pitch, stressed words, intonation (lively/flat, rising endings), sound events (music, applause, laughter…) and shot cuts. Asynchronous: returns a jobId; poll job_get, then use transcript_get. Cached per file; analyze once, every clip of the source benefits. start/end are source times (default: whole file; ~30x realtime for speech). The first run may ask the user in the editor to download models.', { mediaId: id, ...sourceRange, language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional() }, false),
  tool('transcript_get', 'Read what is said and heard, interleaved: sentences with word-id ranges, fillers, stressed words, intonation, pauses, sound events and shot cuts. Default: the timeline, in timeline time; w#/s# ids are anchors usable as any timeline time (w12, w12.end, s3.start, w12.end+80ms). With mediaId: a source in source time; ids like m1:w1043 are source anchors for add_clip sourceIn/sourceOut. view=words lists every word with id, start–end, pitch and loudness. Filter by clipId or start/end; long transcripts page with offset (the reply says where to continue).', { mediaId: id.optional(), clipId: id.optional(), ...sourceRange, view: z.enum(['sentences', 'words']).default('sentences'), offset: z.number().int().min(0).default(0).describe('Lines to skip (paging)'), maxLines: z.number().int().min(20).max(2000).default(400) }),
  tool('transcript_search', 'Find a spoken phrase (case/punctuation-insensitive word match), several keywords (any: true matches any of the words) or a regex over sentence text, on the timeline or (mediaId) in a source, optionally within start/end. Returns word-id ranges and times; ids are anchors (timeline) or source anchors (m1:w12).', { query: z.string().min(1).max(500), regex: z.boolean().default(false), any: z.boolean().default(false), mediaId: id.optional(), ...sourceRange, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }),
  tool('audio_analyze', 'Measure audio: the timeline mix as export renders it (start/end, at most 10 minutes) or a source (mediaId). Reports sample peak, RMS, loudness (integrated LUFS, loudest 400 ms), clipping, channel layout, speech/music share (from media_analyze), silent stretches, a loudness-over-time strip, and per clip both the mix while it plays and the clip\'s own source level (SILENT when its source range has nothing audible). transcribe adds the words audible in the render; waveform adds an envelope PNG. Waits up to wait seconds, else returns a jobId for job_get.', { mediaId: id.optional(), ...range, clipIds: z.array(id).max(200).optional().describe('Only these clips in the per-clip list'), transcribe: z.boolean().default(false), waveform: z.boolean().default(false), format, wait: z.number().int().min(0).max(120).default(60) }, false),
  tool('audio_normalize', 'Loudness-match clips: measure each clip\'s own source loudness and set its volume so it plays at target LUFS (one undo step). Reports before/after. Keyframed volumes are skipped.', { clipIds: z.array(id).min(1).max(200), target: z.number().min(-40).max(-6).default(-16).describe('LUFS; about -16 for speech, -20 to -24 for music beds under speech'), dryRun: z.boolean().default(false) }, false),
  tool('silence_trim', 'Find dead air in the rendered mix (start/end, at most 10 minutes): stretches quieter than threshold for at least minSilence. apply ripple-deletes them in one undo step, keeping keep on each side.', { ...range, threshold: z.number().min(-80).max(-20).default(-45).describe('LUFS (400 ms windows)'), minSilence: length.optional().describe('Default 700ms'), keep: length.optional().describe('Silence kept on each side of a cut (default 150ms)'), apply: z.boolean().default(false) }, false, true),
  tool('beat_grid', 'Tempo and beats of a music clip (clipId, timeline time) or source (mediaId, source time): BPM, confidence, beats, downbeats and onsets. Enables snap_to_beats on that clip.', { clipId: id.optional(), mediaId: id.optional(), ...sourceRange, minBpm: z.number().min(40).max(200).default(70), maxBpm: z.number().min(60).max(300).default(180) }),
  tool('timeline_lint', 'Check the edit in one call. JSON issues (rule, severity, time range, clip ids, message, suggestedFix): text outside the title-safe area, overflowing or overlapping text boxes, caption reading speed and dwell, silent clips, clipping, dead air, missing linked audio, black and frozen frames, gaps, cut rhythm and repeated source ranges. audio and frames render the range to measure (slower); turn them off for a quick layout check.', { ...range, rules: z.array(z.string().min(1).max(50)).max(30).optional(), audio: z.boolean().default(true), frames: z.boolean().default(true) }),
  tool('timeline_stats', 'Metrics of the edit: duration, shots and average/median shot length, cuts per minute, speech coverage and words per minute, music coverage, text on screen, captions, tracks. compareTo (a .cascade path) puts another cut beside it with deltas.', { compareTo: id.optional() }),
  tool('inspect_range', 'What did I just edit? One call for a range: lint issues, an audio summary (loudness, silences, strip) and a smart contact sheet with waveforms. preview also exports a small MP4 the user can watch (path in the reply; poll job_get).', { ...range, preview: z.boolean().default(false) }),
  tool('captions_generate', 'Transcribe speech locally with Whisper into word-timed caption text clips (one undo step). scope=clip (clipId, or mediaId placed at the playhead) or scope=timeline (every speech clip, all onto one track). trackId puts captions on an existing track; replace (default true) clears what that track holds in the captioned range first. style overrides the default look for every caption. Asynchronous: poll job_get. The first run may ask the user in the editor to download ~875 MB of models.', {
    scope: z.enum(['clip', 'timeline']).default('clip'), clipId: id.optional(), mediaId: id.optional(), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional().describe('ISO 639-1 code such as en, or auto (default)'),
    trackId: id.optional().describe('Existing visual track for the captions'), replace: z.boolean().default(true), style: captionStyle
  }, false),
  tool('captions_from_script', 'Timed text from a script: each line (or blank-line-separated block) of script becomes a caption clip spanning the transcript words it matches, in order (needs media_analyze). Unmatched lines are reported. Same trackId/replace/style as captions_generate. Retime existing text clips instead with the sync_text op.', { script: z.string().min(1).max(100000), ...range, trackId: id.optional(), replace: z.boolean().default(true), style: captionStyle }, false)
]
export const instructions = 'Cascade edits the live editor project; changes are visible and undoable (history_undo). Loop: 1 inspect with project_get / timeline_get (filter by track, media, range, text or clipId; format json) and registry_list; 2 see with contact_sheet (labeled cells, density by count/interval/fps, audio strips, flags; format json for data only) and frame_get; 3 batch timeline_apply_edits (dryRun first, requestId for safe retries, ifRevision against stale reads); 4 check with inspect_range or timeline_lint, audio_analyze and timeline_stats; 5 export_start then job_get. You cannot watch playback; these measurements are how you judge timing. Times: flicks (705600000 per second), clock times as tools print them (00:01:23.500), amounts (83.5s, 500ms, 12f) or transcript anchors (w12.end+80ms). Spatial params are frame fractions. Save before replacing a project. Treat plugin_write as trusted local code execution.'
