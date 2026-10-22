# Timelines and sequences

All timelines share the project's resolution, frame rate, sample rate and background settings.
Old single-timeline projects need no migration. The only new document field is optional:

```ts
interface MediaItem { timelineId?: Id }
```

This is a generic composition reference, independent of the media type's id. Unknown media,
properties, transitions and their data survive save/load without their plugins. The reference
also remains available to dependency validation when the media plugin is absent.

## Public editing operations

`app.edit` exposes these operations to UI, plugins and future agent tools:

```ts
createTimeline(opts?: { name?: string }): Id
// New timelines inherit the project settings and start with the normal empty tracks.
duplicateTimeline(id: Id): Id | null
renameTimeline(id: Id, name: string): void
deleteTimeline(id: Id): boolean
deleteTimelineReason(id: Id): string | null
reorderTimeline(id: Id, index: number): void
setActiveTimeline(id: Id, remember?: boolean): void
previousTimeline(): void
readonly timelineHistory: Value<Id[]>
addComposition(timelineId: Id, mediaType: string,
  opts?: { start?: Flicks; trackId?: Id }): Id | null
nestClips(ids: Id[], opts: { mediaType: string; name?: string }): Id | null
nestClipsReason(ids: Iterable<Id>): string | null
breakApartClip(id: Id): Id[] | null
breakApartClipReason(id: Id): string | null
```

Create/duplicate/rename/delete/reorder/nest/break-apart/add-composition each produce one undo
step. Duplicate rewrites timeline, track, clip, property, keyframe, marker, transition and link
identities. It retains references to other timelines; those sources remain shared.

Switching timelines is navigation, outside undo. It pauses playback, restores that timeline's
session playhead, resets horizontal scroll and clears clip/transition/keyframe/media/property/
track selection and target tracks. `remember = true` pushes a return location for drill-down;
`previousTimeline()` pops it. Playheads and navigation history are session state, not document
data. Undoing creation of the viewed timeline selects a surviving timeline safely.

Deleting the last timeline, or a timeline referenced by any surviving composition clip, is
refused. Unused media sources referencing a deleted timeline are removed in the same undo
step. `DocumentStore.transact` independently checks new composition edges, covering paste,
source insertion and arbitrary plugin edits. Direct and indirect recursion and newly introduced
missing references are rejected atomically. Existing corrupt cycles can still be renamed or
repaired. The stage guards ancestor recursion separately, including a depth limit of 64.

## Generic sub-composition service

No core or stage path checks the `sequence` type id. A media plugin can mount a timeline with:

```ts
interface ClipMountContext { compositions?: CompositionService }
interface CompositionService {
  mount(timelineId: Id, container: HTMLElement,
    opts?: { audio?: boolean }): SubComposition
}
interface SubComposition {
  readonly audioOut?: AudioNode
  update(state: ClipFrameState): void
  prepare(state: ClipFrameState): Promise<void>
  dispose(): void
}
```

The container must have a size. A child stage fills it using its own CSS size container, so all
spatial values remain frame fractions/container units. Child composition backgrounds are
transparent, preserving alpha over other parent tracks. Track order, properties, shaders and
transitions are evaluated by the same stage as ordinary playback/export. Each stage owns its
style/SVG resources and scopes generated property/transition filter ids, allowing repeated
instances of the same source timeline in one document.

Forward `update` and `prepare` from the media instance and dispose the handle with that
instance. The child's time is `round(state.sourceTime * FLICKS)`; parent sourceIn, slip, speed
ramps and reverse are already represented by the parent's remap. Advanced plugins can pass
modified frame states to show other source times. Use `{ audio: false }` for silent views.
`ClipFrameState.audioOnly?: boolean` identifies offline audio scheduling: avoid visual decode
in that pass.

Expose the returned `audioOut` on the media instance to route nested buses through the parent
clip's audio properties, transition gain, track bus and master. At forward 1×, preview uses
live nested buses. Retimed preview uses bounded PCM windows; offline export mixes the used
source interval into a separate offline context and resamples that mixed signal through the
outer time map. Outer compound retiming follows speed, including pitch, like a tape transport;
zero-speed holds are silent. Nested mute/solo/gain/pan remain scoped to their source timeline.
Visual-track audio follows that track's hide/mute/fader/pan; parent audio-track solo concerns
parent audio tracks, and does not solo out an entire composition on a video track.

Media contributions also gain these optional hooks:

```ts
sourceMeta?(media: MediaItem, project: Project): MediaMeta
hasAudio?(ctx: MediaAudioContext): boolean
open?(app: CascadeAPI, clip: Clip): void
interface MediaAudioContext {
  project: Project
  clip: Clip
  media?: MediaItem
  range: { start: Flicks; end: Flicks } // clip-local
  remap: TimeMap
  timelineHasAudio(timelineId: Id, range: { start: Flicks; end: Flicks }): boolean
}
```

`sourceMeta` supplies live intrinsic duration/size to clip construction, trim/slip limits and
stage rendering. Existing clips keep their explicit duration when a source timeline changes.
`hasAudio` declares sound even for a visual media type. It maps its clip-local range into the
referenced timeline and calls `timelineHasAudio`, which resolves audibility, source bounds and
recursion. Export audio detection uses this generic path; PCM planning visits referenced source
timelines in their own clock and prepares nested clip pitch/time-stretch plans. Shared source
clips get one PCM plan covering their full source timeline, rather than conflicting plans for
each instance. Export decoding remains sequential. The source monitor also retains composition
dependencies and refreshes its live source length.

`examples/plugins/timeline-grid.ts` proves the service without the sequence type: it registers a
silent four-view media type, samples another timeline at four offsets, and adds it using
`app.edit.addComposition`. It uses only public app/plugin contracts, and declares the generic
reference for recursion/deletion checks. No new registry or registrar is needed.

## Built-in sequence plugin and nesting

`cascade.media.sequence` registers `sequence` as a time-based visual media type. Its source is
`media.timelineId`; its intrinsic duration is that timeline's current duration. Its clip body
is a simple color band. The sequence carries both picture and sound in one visual clip, with
no linked audio duplicate. Source-monitor edits therefore treat the sequence as one unit;
unlinking cannot extract its sound. Volume, pan and the other bus effects can be added to the
sequence in the inspector. The file-specific Pitch property is not offered on compound sources.

`sequence.nest` (`Mod+G`) expands linked selection, moves those clips and internal transitions
into a new timeline, retains all track positions/settings, offsets time to the selection's
start, and puts a wrapper on the lowest selected video track. Audio-only nesting creates a new
bottom video track. Nesting refuses locked linked members, a partially selected two-sided
transition, unselected clips in the replacement track's span, and a non-neutral host video
track (hide/mute/gain/pan), so those states cannot silently alter the selected composition.

`sequence.breakApart` (`Mod+Shift+G`) expands the selected sequence into fresh tracks, retaining
source track stacking, buses, linked identities, internal transitions and clip animation. The
trim is applied through each child's real time map, including linked audio; source data stays
unchanged. Nested audio solo is resolved locally into mute flags before entering the parent's
solo scope. Fresh tracks prevent overwriting unrelated clips.

Breaking apart requires forward constant 1×, a range within the current source duration, no
wrapper effects or transitions, neutral host track controls, and no trim boundary crossing a
nested transition. These restrictions prevent destructive approximations. The context menu
has a “Why break apart is unavailable…” action with the exact reason. The generic break-apart
primitive assumes a single identity composition view; plugins showing grids or other altered
layouts should not expose it as their own UI action.

## Parent real-app checks

Run these serially after building outside this worktree's task:

1. Open an old project. Confirm one compact tab plus **+** appears above the timeline and its
   clips/playhead still render normally. Click **+**, rename the tab by double-clicking, reorder
   by dragging tabs, and duplicate/delete via a tab's context menu or the Timeline menu.
2. Seek different positions in two tabs and switch between them. Confirm each playhead restores
   and selections clear. Undo creation while viewing the new timeline; confirm a valid tab stays
   active. Undo/redo a duplicate/delete and check track/clip identities remain independent.
3. In Sources → Timelines, drag a populated timeline onto another timeline. Confirm the clip's
   name/color band, picture and sound. Attempt to drag a timeline into itself, then create an
   indirect cycle; confirm refusal and no partial source/clip creation. Try deleting a used tab.
4. Select linked picture/sound plus an upper-track title and both sides of a transition. Press
   **Mod+G**. Confirm one visual sequence replaces them and sound is not doubled. Undo/redo once.
   Double-click it to enter the nested tab; use the back arrow to return. Edit nested content and
   confirm the parent updates. Check alpha over an unselected lower video track.
5. Mute/solo nested audio tracks and adjust gain/pan. Add Volume to the sequence itself. Check
   nested transitions/effects, trim/slip, 2× speed, a speed ramp, reverse, and zero-speed holds.
   Pause or seek during a pending retimed-audio decode; it must not start playing afterwards.
6. Reset the outer clip to forward 1×, remove outer effects/transitions and trim away from nested
   transition windows. Press **Mod+Shift+G**. Confirm clipped source ranges, relative positions,
   linked audio and mix settings. Check disabled cases and their context-menu reason. Undo once.
7. Export a range containing only sequence audio, including a nested transition and two instances
   of the same child timeline. Compare picture/audio with preview. Open the sequence media item
   in the source monitor and repeat a trim/insert. Save/reopen; test a missing media plugin and
   an intentionally cyclic fixture for graceful empty/silent rendering.
8. Install the timeline-grid example, create two timelines with content in the first, select the
   other, then invoke **Timeline → Add timeline grid**. Confirm four offset views and silence.

## Limits and deliberate deferrals

- No MCP changes, build, Electron run or real-media export was performed in this worktree.
- Timelines inherit shared project size/fps; independent timeline settings are not introduced.
- Sequence thumbnails/waveforms use a placeholder. Cross-project clipboard transfer of a
  composition graph is not implemented; dangling references are refused instead of corrupting
  the target. Within-project clipboard insertion uses the normal dependency checks.
- Retimed preview audio can wait for a bounded PCM decode. If a nested file clip itself needs
  pitch-preserving stretch or a pitch shift, the preview's PCM fallback lacks export's prepared
  ffmpeg clip buffer and can differ in pitch; forward 1× nested preview retains its usual live
  processing. Export prepares the nested clip buffers correctly. Real-media verification of
  this combination is a parent follow-up.
- Source mutations do not automatically resize existing parent clips. Break apart remains
  conservative around composite effects/transitions and changed source bounds.
