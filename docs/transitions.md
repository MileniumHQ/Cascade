# Transitions

Tracks optionally contain `TransitionInstance[]`: plugin type id, outgoing `from` and/or incoming `to` clip ids, integer-flick `duration`, `align` (`center`, `start`, `end`) and JSON `params`. Two-sided transitions require adjacent clips on one track. Single-sided fades are inside their clip. Unknown plugin ids/params are retained in saved projects and skipped by the stage.

Use `ctx.transitions.register(transition: TransitionContribution)` in either editor or render plugins. Contributions declare `id`, `name`, `description`, `icon`, `kinds: ('visual' | 'audio')[]`, static `params: ParamDef[]`, optional `singleSided` (default true), and optional `defaultDuration` in seconds (default 0.5) and optional `linked: { audio?, visual? }` naming the type to pair on the other track kind. The same registered contributions appear in the cut menu and inspector; user plugins require no UI changes.

`apply(p, values, ctx)` receives raw progress in [0,1] and returns `{ from?: PropertyOutput; to?: PropertyOutput }`. `ctx` provides `id`, `u: StageUnits`, `mode`, `project`, optional `from`/`to` clips, flick `duration`, and `elements: { from?, to?, document }`. Outputs apply to frame-sized parents, independently of the clips' properties. Lengths use `ctx.u` or frame percentages, never pixels. Compose CSS with `transform`, `filter`, `backdropFilter`, `style`, or `svgFilter`. `contentStyle` also styles the frame layer; `extra` has no clip-property semantics here. Tag any escape-hatch nodes `data-cs-owner="tx:<ctx.id>"` for automatic removal when the transition stops applying. A dissolve should keep the outgoing side opaque while bringing in the incoming side, so compositing does not inadvertently expose the background.

`gain(p, values)` optionally returns `{ from: number; to: number }` with linear gains. The fallback is equal power (`cos(p*π/2)`, `sin(p*π/2)`). Opposite-edge fades multiply. The built-in audio crossfade offers equal-power, linear, and exponential curves. Built-ins resolve their easing select internally; the stage always supplies raw progress.

Editing primitives:

```ts
app.edit.addTransition({ type, from?, to?, duration?, align?, params?, linked? }, opts?: GestureOpts): Id | null
app.edit.updateTransition(id, { type?, duration?, align?, params? }, opts?: GestureOpts): void
app.edit.removeTransitions(ids: Id[]): void
```

`duration` is in flicks. `opts.gesture` is `start | update | end`. Parameter patches merge; switching type keeps parameters with matching ids and parameter types. `linked: false` opts out of paired audio creation. Otherwise adjacent linked picture/sound clips receive an audio transition chosen in order: `TransitionContribution.linked.audio` (a registered type id to pair with), the selected transition itself when it supports audio, then the first registered compatible audio transition. Paired transitions share duration/alignment updates and deletion; if any track holding a member of the pair is locked, updating or removing it is rejected as a whole. Instances store an optional `linkId` for this pairing. `nearestTransitionEdge(track, time, cutsOnly?)`, `transitionWindow(track, transition)`, and `findTransition(timeline, id)` are exported from `core/transitions.ts`.

Every document transaction normalizes transition integrity in its own undo entry: missing or nonadjacent clips drop the transition, duration clamps to at least one frame and at most the shorter clip, and duplicate edge assignments are removed. Clips shorter than a frame cannot carry transitions. Split and overwrite-split operations transfer outgoing end edges to the new right piece. Duplicating/pasting clips does not copy transitions.

During a transition, both sides render outside their ordinary clip boundaries. Speed ramps extrapolate at the boundary speed; reverse mapping is supported. Picture handles clamp to the available source, holding its first/last frame; missing audio handles are silent. Audio export includes transition handles in decoding, time stretching, automation and chunk gating. Media plugins that schedule their own audio should honor `ClipFrameState.activeRange` (timeline flicks), and use `state.remap` for source mapping.

In the timeline, click a chip to select it, drag its available edges to resize, or press Delete. Drag a clip's upper corner handle inward for a fade. Right-click a cut for the registered transition submenu. The inspector edits type, duration, alignment, and contribution parameters. Mod+T adds the first visual transition at the nearest cut on selected or target tracks; Mod+Shift+T adds the first audio transition. The built-in visual default is Cross dissolve and audio default is Crossfade.

See `examples/plugins/iris-transition.ts` for a third-party circle wipe.
