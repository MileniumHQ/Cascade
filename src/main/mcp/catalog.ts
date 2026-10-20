/** Shared, browser-safe tool schemas. Transport and renderer validate the same contract. */
import { z } from 'zod'
const id = z.string().min(1).max(256)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Integer flicks (705600000 per second), never seconds')
const positiveTime = time.refine(v => v > 0, 'Must be positive')
/** Word/sentence anchor from transcript_get: w12, w12.end, s3.start, w12.end+80ms, s3-0.5s. */
export const ANCHOR = /^([ws]\d+)(?:\.(start|end))?(?:([+-])(\d+(?:\.\d+)?)(ms|s))?$/
const at = z.union([time, z.string().regex(ANCHOR, 'Expected flicks or an anchor like w12, w12.end, s3.start, w12.end+80ms')])
  .describe('Integer flicks, or a transcript anchor: w12 / w12.end / s3.start, optional offset +80ms / -0.5s. Anchors resolve against the edits so far in this batch.')
const detail = z.enum(['concise', 'detailed']).default('concise')
const dimensions = z.number().int().min(16).max(8192)
export const settingsSchema = z.object({ width: dimensions.optional(), height: dimensions.optional(), fps: z.object({ num: z.number().int().positive().max(240000), den: z.number().int().positive().max(10000) }).optional(), sampleRate: z.number().int().min(8000).max(192000).optional(), background: z.string().max(128).optional() }).strict()
const placement = { start: at, duration: positiveTime, trackId: id.optional(), ref: id.optional() }
export const editSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_clip'), mediaId: id, ...placement, sourceIn: time.optional() }).strict(),
  z.object({ op: z.literal('add_text'), text: z.string().max(10000), ...placement }).strict(),
  z.object({ op: z.literal('move'), clipId: id, start: at, trackId: id.optional() }).strict(),
  z.object({ op: z.literal('trim'), clipId: id, edge: z.enum(['start', 'end']), time: at }).strict(),
  z.object({ op: z.literal('split'), clipId: id, time: at, ref: id.optional() }).strict(),
  z.object({ op: z.literal('delete'), clipId: id }).strict(),
  z.object({ op: z.literal('ripple_delete'), start: at, end: at }).strict(),
  z.object({ op: z.literal('set_param'), clipId: id, propertyId: id.describe('Instance id or property type, e.g. transform'), paramId: id, value: z.unknown(), time: at.optional().describe('Clip-local integer flicks, or an anchor (converted to clip-local)') }).strict(),
  z.object({ op: z.literal('add_keyframe'), clipId: id, propertyId: id, paramId: id, time: at.describe('Clip-local integer flicks, or an anchor (converted to clip-local)'), value: z.unknown(), easing: id.optional() }).strict(),
  z.object({ op: z.literal('add_property'), clipId: id, type: id, ref: id.optional() }).strict(),
  z.object({ op: z.literal('remove_property'), clipId: id, propertyId: id }).strict(),
  z.object({ op: z.literal('add_marker'), time: at, name: z.string().max(1000) }).strict()
])
export type Edit = z.infer<typeof editSchema>
const sheet = { start: time.optional(), end: time.optional(), count: z.number().int().min(1).max(24).optional(), interval: positiveTime.optional(), columns: z.number().int().min(1).max(8).default(3) }
const tool = <T extends z.ZodRawShape>(name: string, description: string, shape: T, readOnly = true, destructive = false) => ({ name, description, schema: z.object({ ...shape, detail }).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: !readOnly } })
export const tools = [
  tool('project_get', 'Inspect the open project, settings, tracks and duration. Start here.', {}),
  tool('project_new', 'Create and save a project through the editor session. Replaces the open project; save first.', { name: z.string().min(1).max(200), settings: settingsSchema.optional() }, false, true),
  tool('project_open', 'Open an absolute .cascade file through the editor session. Save current work first.', { path: id }, false, true),
  tool('project_save', 'Save the current project to its existing path without dialogs.', {}, false),
  tool('project_settings_set', 'Set project reference resolution, frame rate or background. Undoable.', { settings: settingsSchema }, false),
  tool('media_list', 'List imported sources with short ids, types and durations.', {}),
  tool('media_import', 'Import absolute file paths (or ~/ paths). Returns source ids; does not add timeline clips.', { paths: z.array(id).min(1).max(100) }, false),
  tool('media_probe', 'Probe a file without importing it.', { path: id }),
  tool('timeline_get', 'One line per clip: short id, track, start/end timecodes, type, name and property summary; plus markers. Detailed includes document JSON.', {}),
  tool('timeline_apply_edits', 'Validate the entire batch then commit one undo step. Times are integer flicks. ref assigns an alias usable by later operations in this batch. Placement overwrites overlaps; split/delete/move include linked audio. ripple_delete removes a time range on all unlocked tracks. Any time may be a transcript anchor (w12.end+80ms) from transcript_get; anchors re-resolve after each op, so e.g. several ripple_deletes by word in one batch stay correct.', { ops: z.array(editSchema).min(1).max(200) }, false, true),
  tool('timeline_undo', 'Undo the latest document edit (including edits made in the UI).', {}, false, true),
  tool('timeline_redo', 'Redo the latest undone document edit.', {}, false, true),
  tool('history_get', 'Get undo/redo availability, next labels and recent observed edit events.', {}),
  tool('registry_list', 'Discover media types, property parameter defaults/types/units/ranges, easings, generators and exporters.', {}),
  tool('frame_get', 'Render one timeline frame as a PNG. If the frame service is unavailable, returns recovery guidance.', { time: at, width: z.number().int().min(64).max(1568).default(960) }),
  tool('contact_sheet', 'See a timeline range as ONE JPEG grid, with cell/timecode mapping, <=1568px long edge. Default 9 cells. count and interval are mutually exclusive.', sheet),
  tool('timeline_preview_sheet', 'See evenly spaced frames across the entire edit as ONE JPEG grid.', { count: z.number().int().min(1).max(24).default(9), columns: z.number().int().min(1).max(8).default(3) }),
  tool('media_contact_sheet', 'See raw source media without adding it to the timeline. ONE labeled JPEG grid.', { mediaId: id, ...sheet }),
  tool('plugin_write', 'Write executable trusted property plugin TypeScript, compile and wait for renderer hot reload. Read plugin_api_docs first. This grants local application code execution.', { name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100), code: z.string().min(1).max(200000) }, false, true),
  tool('plugin_list', 'List user plugins, compile errors and activation status.', {}),
  tool('plugin_remove', 'Remove a user plugin from disk and hot unload it. Existing document instances remain preserved.', { name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100) }, false, true),
  tool('plugin_api_docs', 'Concise property plugin authoring contract and a working import-free example that loads from userData.', {}),
  tool('export_start', 'Start an asynchronous export; poll job_get. Output is an absolute path. Discover exporter ids with registry_list.', { exporter: id, start: time.optional(), end: time.optional(), width: dimensions.optional(), height: dimensions.optional(), output: id, options: z.record(z.string(), z.unknown()).default({}) }, false, true),
  tool('job_get', 'Inspect export progress and terminal status by job id.', { jobId: id }),
  tool('export_cancel', 'Cancel an export job.', { jobId: id }, false, true),
  tool('media_analyze', 'Analyze a source locally so you can edit by content: verbatim words with timings (incl. um/uh), sentences, pauses, per-word loudness, vocal tone, sound events (music, applause, laughter…) and shot cuts. Asynchronous: returns a jobId; poll job_get, then use transcript_get. Cached per file; analyze once, every clip of the source benefits. start/end are SOURCE flicks (default: whole file; ~30x realtime for speech). The first run may ask the user in the editor to download models.', { mediaId: id, start: time.optional(), end: time.optional(), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional() }, false),
  tool('transcript_get', 'Read what is said and heard on the timeline, in timeline time: sentences with word-id ranges, fillers, emphasis, tone, pauses, sound events and shot cuts, interleaved. view=words lists every word with its id and timecode (use for precise cuts). Filter by clipId or start/end (timeline flicks). w#/s# ids are anchors usable as any time in timeline_apply_edits and frame_get (w12, w12.end, s3.start, w12.end+80ms).', { clipId: id.optional(), start: time.optional(), end: time.optional(), view: z.enum(['sentences', 'words']).default('sentences'), maxLines: z.number().int().min(20).max(2000).default(400) }),
  tool('transcript_search', 'Find a spoken phrase (case/punctuation-insensitive word match) or a regex over sentence text. Returns word-id ranges and timecodes; ids are anchors for timeline_apply_edits.', { query: z.string().min(1).max(500), regex: z.boolean().default(false) }),
  tool('captions_generate', 'Transcribe a video/audio clip (or source) locally with Whisper and add word-timed caption text clips on a new Captions track (one undo step). Asynchronous: returns a jobId; poll job_get. Only the clip\'s used source range is transcribed (~30x realtime on GPU). The first run may ask the user in the editor to download ~875 MB of models. Give clipId (placed at the clip) or mediaId (placed at the playhead).', { clipId: id.optional(), mediaId: id.optional(), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional().describe('ISO 639-1 code such as en, or auto (default)') }, false)
]
export const instructions = 'Cascade edits the live editor project; changes are visible and undoable. Recommended loop: 1 inspect with project_get / timeline_get and registry_list; 2 see with timeline_preview_sheet / contact_sheet; 3 batch timeline_apply_edits; 4 verify with sheets; 5 export_start then job_get. All times are integer flicks (705600000 per second), spatial params are frame fractions. Use concise output by default. Save before replacing a project. Treat plugin_write as trusted local code execution.'
