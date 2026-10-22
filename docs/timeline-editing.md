# Timeline editing primitives

Clipboard and edit operations are independent of media/property type ids. Built-in commands and pointer tools are plugins. Unknown plugin data survives clip serialization, splitting and pasting.

## Public extension points

`PluginContext.timelineTools: Registrar<TimelineToolContribution>` registers tools in `app.registries.timelineTools: Registry<TimelineToolContribution>`. The timeline plugin creates their toolbar buttons, commands (`timeline.tool.<id>`), optional keybindings and Timeline menu entries, including for tools installed after panel activation. Unregistering an active tool selects the default tool. `app.view.tool: Value<string>` holds the active tool per app.

```ts
interface TimelineToolContribution extends Contribution {
  name: string
  icon: Icon
  key?: string
  cursor: string
  pointerDown(event: PointerEvent, context: TimelineToolContext): Cleanup | void
}
interface TimelineToolHit { clipId?: Id; trackId: Id; edge?: 'start' | 'end' }
interface TimelineToolContext {
  app: CascadeAPI
  hitTest(clientX: number, clientY: number): TimelineToolHit | null
  timeAt(clientX: number): Flicks
  clientXAt(time: Flicks): number
  snap(time: Flicks, exclude: Set<Id>, disable: boolean): Flicks
  selectClip(id: Id, event: PointerEvent): void
  moveClip(event: PointerEvent, id: Id): Cleanup | void
  trimClip(event: PointerEvent, id: Id, edge: 'start' | 'end'): Cleanup | void
  feedback(text: string | null, event?: PointerEvent): void
}
```

See `examples/plugins/timeline-tool.ts` for a third-party seek tool. A tool owns its drag listeners and returns an idempotent cleanup to cancel/unmount them.

`CascadeAPI.clipboard: ClipboardService` exposes:

```ts
read(): Promise<ClipboardPayload | null>
copy(ids?: Id[]): Promise<void>
cut(ids?: Id[]): Promise<void>
paste(insert?: boolean): Promise<Id[]>
copyProperty(clipId: Id, propertyId: Id): Promise<void>
pasteProperty(ids?: Id[]): Promise<void>
```

Clip payloads use `{ cascade: 'clips', version: 1, clips, media }`, with each entry containing `{ clip, kind, trackOffset, sourceTrack }`. Times are relative to the earliest copied start; offsets run top-to-bottom within each track kind. Property payloads use `{ cascade: 'property', version: 1, property }`. Copy writes JSON to the OS clipboard, with a window-local fallback if clipboard permission fails. Paste imports media entries and deduplicates file-backed entries by path. Clip, property, keyframe and link ids are regenerated. The primary selected clip is first in the payload for attribute paste.

New `app.edit` methods (delta and duration are integer flicks):

```ts
rippleTrim(clipId: Id, edge: 'start' | 'end', t: Flicks,
  opts?: GestureOpts & { linked?: boolean }): void
rollEdit(clipId: Id, edge: 'start' | 'end', delta: Flicks,
  opts?: GestureOpts & { linked?: boolean }): void
slipClip(clipId: Id, delta: Flicks, opts?: GestureOpts & { linked?: boolean }): void
slideClip(clipId: Id, delta: Flicks, opts?: GestureOpts & { linked?: boolean }): void
closeGap(trackId: Id, t?: Flicks): void
closeAllGaps(trackIds?: Id[]): void
pasteProperties(ids: Id[], properties: PropertyInstance[],
  opts?: { includeKeyframes?: boolean }): void
freezeFrame(clipId: Id, t?: Flicks, duration?: Flicks): Id | null
```

`deleteClips(ids, ripple?)` defaults to the ripple-mode setting when its second argument is omitted. Explicit `false` retains ordinary deletion. Ordinary `trimClip` follows ripple mode and otherwise shares handle limits across linked members.

Pure operations are exported from `core/timeline-ops.ts`:

```ts
type LimitsFor = (clip: Clip) => TrimLimits
rippleTrim(tl: Timeline, clipId: Id, edge: 'start' | 'end', t: Flicks,
  opts?: { limits?: LimitsFor; linked?: boolean }): Flicks
rollEdit(track: Track, leftId: Id, rightId: Id, t: Flicks, limits?: LimitsFor): Flicks
slipClip(clip: Clip, delta: Flicks, limits?: TrimLimits): Flicks
slideClip(track: Track, clipId: Id, delta: Flicks, limits?: LimitsFor): Flicks
insertTime(tl: Timeline, trackIds: Iterable<Id>, at: Flicks, duration: Flicks): boolean
closeLinkedGap(tl: Timeline, trackId: Id, t: Flicks): boolean
linkedTrackClosure(tl: Timeline, trackIds: Iterable<Id>, at: Flicks): Set<Id>
cloneClip(clip: Clip): Clip
timeMapFor(clip: Clip): TimeMap
```

Use `withTimeMaps` for standalone pure operations with remap properties. The editor wrappers scope time maps automatically. Slip deltas are clip-local timeline flicks; their source displacement is the time-map integral. Roll and slide require touching neighbours. Ripple-start trimming keeps the timeline start fixed while changing source-in, duration and the downstream shift. Operations reject locked linked partners or incompatible link boundaries atomically. Gap closure notifies when synchronization prevents closing an interval.

Ramp integrals are rebased at clip-local zero after trims/splits, including when retained keyframes have negative times. Speed zero consumes no source time. Its generalized inverse maps offset zero to local zero and unreachable offsets to signed infinity; trims of an entirely held clip ignore source exhaustion. Frame holds sample properties at the playhead, insert a zero-speed visual segment and an empty interval on linked audio tracks. No media ids are hard-coded. Zero-containing audio ramps use resampling and silence zero-speed plateaus; pitch preservation across those ramps is deferred.

## Built-in controls and manual verification

1. Select linked footage, press Mod+C, click a destination track header and seek the playhead. Mod+V should overwrite, select the result and advance the playhead. Repeat paste and undo each action once. Paste into another window/project: referenced media should arrive once per file path. Mod+Shift+V should split straddling destination clips and insert time on linked partner tracks. Locked destinations/partners should leave the project unchanged.
2. Copy a clip, select another, then Mod+Alt+V. Check the property list and Include keyframes toggle. Apply to several selected clips: non-stackable types replace; stackable types append. In an inspector card's context menu, Copy property then Paste property should transfer one instance with fresh ids.
3. The toolbar order is Select (V, existing A alias), Blade (C), Ripple (B), Roll (R), Slip (Y), Slide (U). Drag ripple edges, a shared roll cut, a slip body and a slide body between touching neighbours. Check linked A/V, source handles, reverse and speed ramps; check live deltas and slip source in/out. Shift-drag a Select edge requests ripple; Alt retains its snapping/linked-selection override. Undo a complete drag once. Cancel a drag or unmount the panel without leaving listeners/gestures open.
4. Shift+R or the toolbar enables ripple mode. Ordinary Select edge trims, Delete and Mod+X should close time and keep linked tails synchronized. Right-click empty space and choose Close gap. Timeline > Close gap uses the target track/playhead; Close all gaps uses tracks containing selected clips, otherwise unlocked tracks. Check a conflicting or locked audio partner: the gap should remain and a notification should explain why.
5. Seek inside selected footage and press Shift+F, or use Freeze frame in the clip/Timeline menus. Check the default two-second hold, silent audio interval, resumed source time and one-step undo. Change Settings > Timeline > Frame hold duration. Repeat with reversed and ramped speed, at the clip start, and with no selection (topmost unlocked visual clip). No optional hold-after variant was added.
6. Install the example seek tool as a user plugin. It should appear without modifying the timeline code, work after activation, and disappear cleanly on unload.

Electron and build verification are intentionally left to the parent, per the resource-limit instructions.
