# UI contributions

The built-in panels (timeline, inspector, sources, preview) only host UI; features add theirs
through contribution points. All of them are framework-agnostic: `mount(el, ctx) => cleanup`
(the cleanup is optional), editor only (ignored in the headless export worker). The types live in
`src/core/ui-contributions.ts` and are re-exported from `src/core/plugin-api.ts`. A runnable example
for every point is `examples/plugins/ui-contributions.ts`.

Markers, transition chips and fade handles, the transition inspector, the Timelines list and the
path handles are built on these points in their own plugins (`markers/`, `transitions/editor.tsx`,
`sequence/editor.tsx`, `params/path-editor.ts`). Removing one of those plugins leaves the panels working.

| Registrar | Purpose |
| --- | --- |
| `ctx.timelineDecorations` | Mount UI on the `ruler`, a `track` lane or a `clip` body. `when(app, {track, clip})` filters; `order` stacks. |
| `ctx.snapTargets` | `points(app, exclude)` → extra snap times for timeline drags (clip edges and the playhead are built in). |
| `ctx.timelineMenus` | `items(app, {track, clipId?, time})` → entries at the top of the `clip` or `lane` context menu. |
| `ctx.timelineDrops` | `accepts(dataTransfer)` (types only) + `drop(app, dataTransfer, {start, trackId?, trackKind?})`. Read `getData` before any `await`. First match by priority wins; media, generators and OS files are the fallback. |
| `ctx.inspectorSections` | `subject: 'clip'` appends under the focused clip's cards. Any other `subject` needs `selection(app) => Value<Id[]>` (e.g. `app.selection.transitions`): the inspector shows the first section whose selection is non-empty (and `when` passes). |
| `ctx.sourceSections` | A block in the Sources panel above the media list (`order`). |
| `ctx.sourceItemDecorations` | Badges and bars over each media item's thumbnail. |

## Timeline decoration context

`x(t)` is a pixel offset from the left of the decorated area (the lane start for `ruler` and
`track`, the clip's own left edge for `clip`) and may be negative or beyond `width()`. `timeAt(x)` is
its inverse; `range()` gives the visible times, `track()` / `clip()` the subject. `snap(t, exclude?,
disable?)` snaps like the timeline (including every `snapTargets` provider) and `showSnapGuide(t | null)`
draws the snap line while you drag. `subscribe(fn)` fires on zoom, scroll, resize and document changes;
redraw there. Edits go through `app.edit.*` and gestures (`app.doc.beginGesture` / `endGesture`) as usual.

## Viewer service

`app.services.get(VIEWER_SERVICE)` (`'viewer'`) is a `ViewerService`: `create(host, feed?)` renders a
`ViewerFeed` (project, timeline id, time, playing, rate, change events) into `host` and returns a
`Viewer` (`setDisplaySize`, `request`, `dispose`). Without a feed it shows the editor timeline. The
Source monitor uses it to show a media item with its own transport.

## Preview overlays

`OverlayContext` adds `clipCorners(clipId)` (the clip's transformed corners in overlay px) and an
input-ownership protocol: an overlay that edits directly calls `claimInput()` while active and releases
it when done; other overlays check `inputClaimedByOther()` (and redraw on `onInputClaims`) and hide
while it is true. The transform gizmo yields this way. Param types opt into direct editing with
`ParamTypeContribution.directEdit` (the id of the overlay that edits them); the inspector editor sets
`app.selection.param` to pick which param of the focused property the overlay targets.

## Panel groups

`PanelContribution.group` makes top-region panels share one slot as tabs (Preview + Source). Bottom and
side panels already present every panel as a tab / switch button in a single slot, so a group there
changes nothing visible; `app.layout.reveal(panelId)` focuses a panel in any region.
