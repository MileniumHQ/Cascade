# Markers and clipboard formats

`Marker` retains `id`, `t`, `name`, `color?` and adds `duration?: Flicks`, `note?: string`, `kind?: string`, `data?: unknown`. Timeline markers live on `Timeline.markers`; source markers live on `Clip.markers?`. All times are integer flicks. Known time fields are rounded/clamped on document construction/load; unknown fields, kind IDs and plugin data survive loading and ordinary edits.

Clip marker `t` uses **absolute source time**, in the same coordinates as `clip.sourceIn`. Its timeline position is `clip.start + map.localAt(marker.t - clip.sourceIn)` using `app.edit.timeMap(clip)`. `clipMarkerTimelineTime(clip, map, marker): Flicks | null` returns null outside the clip's source span / half-open timeline interval; `clipMarkerSourceTime(clip, map, timelineT): Flicks` performs the inverse. These account for variable speed, holds and reverse playback. Hidden markers remain stored through trim/slip and appear as “trimmed out” rows in the panel. Clip marker duration also uses source flicks; its band spans from `t` to `t + duration` and is clipped to the visible clip. A reversed range can extend left of its anchor.

Split partitions markers by their original mapped timeline position, with the cut frame belonging to the right half. Markers outside both halves' source spans are omitted by a split. Duplicate and paste preserve marker metadata and assign fresh marker IDs. Ordinary trimming/slipping retains hidden markers.

## Contributions and editing

`MarkerKindContribution extends Contribution { name: string; icon?: Icon; color?: string }` is registered through `ctx.markerKinds.register(...)` and read through `app.registries.markerKinds`. The built-in plugin provides `marker` (white), `chapter` (light blue), and `todo` (amber). Color resolution is `marker.color ?? kind.color ?? '#ffffff'`. An unavailable kind renders as a plain marker and its data remains editable.

The public undoable API is:

```ts
app.edit.addMarker(t: Flicks, name?: string, opts?: {
  clipId?: Id; duration?: Flicks; color?: string; kind?: string;
  note?: string; data?: unknown
}): Id
app.edit.updateMarker(id: Id, patch: Partial<Omit<Marker, 'id'>>, opts?: GestureOpts): void
app.edit.moveMarker(id: Id, t: Flicks, opts?: GestureOpts): void
app.edit.removeMarkers(ids: Id[]): void
```

`addMarker` and `moveMarker` receive timeline time even for clip markers; `updateMarker` patches stored coordinates directly. IDs use `mk_` and address either scope. Add returns an empty ID for invalid time, missing clips or locked tracks. Clip marker edits respect track locks. Drag updates use `GestureOpts` (`start` / `update` / `end`) and make one undo step. `app.selection.markers: Value<Id[]>` and `setMarkers(ids: Id[])` are exclusive with clip/transition selection.

`shiftMarkers(markers, at, delta)` shifts starts at/after `at`. Negative deltas remove starts in `[at, at - delta)`. Range lengths remain unchanged. Insert, insert-paste, ripple delete, ripple trim, gap closing and frame holds apply this once per edit interval to timeline markers. Core edit primitives take `rippleMarkers` (default true) and `ripple` (default false) as explicit options (`RippleOptions` in `core/editing.ts`); they never read settings. The editor's `timeline.rippleMode` / `timeline.rippleMarkers` settings are resolved by the built-in UI commands and tools (`plugins/builtin/ripple.ts`) and passed explicitly. Linked deletions union their removed intervals so linked audio/video do not shift markers twice. Markers remain global annotations even when an edit affects only some tracks.

## Editor

The Markers panel uses the existing bottom tab strip (as do Timeline, Keyframes, Export and Mixer, which currently have no explicit `group`). Rows show timeline time, color, name, kind, note and owning clip. Click the time/row to select and seek, Shift-click to extend selection, rename inline, or use the edit/delete buttons. The kind filter includes unavailable kinds. Trimmed-out rows show source time and remain editable, including source position in their popover; they cannot seek to an absent timeline frame.

Ruler/clip pins support selection, seek, snapped dragging, double-click editing, and a context menu with edit/delete/color. The editor uses the shared glass popover and supports name, timeline position, color swatches, kind, note and duration. Playhead and clip drags snap to timeline markers and visible source markers using their real time maps.

Commands: `markers.add` (`M`), `markers.next` (`Shift+M`), `markers.prev` (`Mod+Shift+M`), `markers.addClipMarker` (clip context menu), `markers.edit`, `markers.setColor`, `markers.delete`, `markers.exportCsv`, `markers.copyChapters`, `markers.open`. `timeline.marker` remains an alias. `M` at an existing visible marker opens its editor. A new clip marker uses the playhead clamped inside the target clip. Delete/Backspace prioritize selected markers through `timeline.delete`.

CSV and YouTube chapter exports copy text to the system clipboard. CSV contains visible timeline/source markers with timeline seconds and stored duration in flicks. Chapter export uses chapter kinds if any exist, otherwise all visible markers, sorts by time, collapses identical whole seconds, removes line breaks from names and inserts `0:00` with the first chapter name if needed. Times become `H:MM:SS` at one hour. Navigation uses all visible markers and stops at the first/last marker.

## Clipboard

```ts
interface ClipboardFormatContribution extends Contribution {
  canCopy(app: CascadeAPI): boolean
  copy(app: CascadeAPI): unknown | Promise<unknown>
  canPaste(app: CascadeAPI, data: unknown): boolean
  paste(app: CascadeAPI, data: unknown, opts: { insert: boolean }):
    Id[] | void | Promise<Id[] | void>
  remove?(app: CascadeAPI, data: unknown): void
}
```

Register via `ctx.clipboardFormats`; inspect via `app.registries.clipboardFormats`. Higher numeric priority wins, including third-party contributions. `remove` is an optional generic cut primitive: the service writes the copied payload first and calls removal only if the project snapshot has not changed during clipboard access. Formats without it support copy/paste and leave cut unavailable. Plugins own their data validation, applicability, transaction boundaries and selection updates.

New payloads use `{ cascade: 1, format: string, data: unknown }`. Paste dispatches to the registered matching format after `canPaste` validation. Legacy clip/property payloads are still read. For compatibility with existing bare service embedders/tests, an app with no clipboard formats registered continues to copy/paste legacy clips. In the full app, clips are the lowest-priority built-in format (`-1000`), keyframes have priority `100`, and markers `200`. Existing property/attribute clipboard commands remain supported.

Keyframe payloads store source clip/instance IDs, property type, param ID/type, values, easing and times relative to the earliest selected timeline keyframe. Paste targets selected clips at the playhead, preferring the same property instance on its source clip, otherwise the first instance of the same property type. Missing applicable properties are created with plugin defaults. Unavailable/inapplicable properties, incompatible param types/value shapes and keys outside the half-open clip duration are skipped. Identical key times are replaced. All destinations and property additions share one undo step. Cut removes only the copied IDs on unlocked tracks. Clipboard shortcuts retain the existing text-field focus guard.

Marker copy stores visible selected markers relative to their earliest timeline position. Paste creates timeline markers with fresh IDs in one undo step, preserving kind, note, color and plugin data. Source markers therefore become timeline annotations when pasted; hidden source markers are not copied. No MCP tools were added in this pass.

See `examples/plugins/review-markers.ts` for a third-party kind and clipboard format using the public API.
