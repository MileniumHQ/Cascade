# Paths, masks and curves

These features use ordinary parameter, property and overlay contributions. No media
or property IDs are embedded in the kernel or stage. Missing plugins retain their
project data; their output is skipped until the plugin becomes available again.

## Path parameter

```ts
interface PathPoint {
  x: number
  y: number
  in?: [number, number]
  out?: [number, number]
}
interface PathValue { closed: boolean; points: PathPoint[] }
// ParamDef
{ id: 'outline', label: 'Outline', type: 'path', default: aPath }
```

Coordinates are fractions of the **untransformed clip content box**: x=1 is its
width, y=1 its height. Coordinates may extend beyond the box. Tangents are relative
to their point, in the same units. This local choice makes masks follow transforms,
sizing, skew, flips and 3D tilt. Frame-length controls such as feather retain the
usual fraction-of-frame-height units before the clip transform.

`path` normalizes finite coordinates, formats a point count, and interpolates every
point and tangent when point counts and closure match (missing handles are zero).
Incompatible topology holds the previous value until the next key. It exposes no
numeric graph channels because topology is variable. Keyframes remain available in
the inspector and keyframe panel. Optional `config: { presets: true }` adds Rectangle
and Ellipse buttons next to Reset; ordinary paths get the compact point-count row.

Select a property card exposing any path parameter. Its path handles appear on the
preview; **Edit on preview** focuses them and picks that row when a property has
multiple path params. The overlay uses the clip's transformed DOM quad with a
projective inverse for pointer editing, including adaptive preview scaling. Cubics
are sampled before projection when drawing the outline, rather than projecting
control handles as if a perspective transform were affine.

- Drag a point or the shape body to move it.
- Drag tangent handles; Alt leaves the opposite handle unchanged. Otherwise the
  opposite handle mirrors the dragged handle.
- Click a segment to insert a point using exact de Casteljau subdivision. The new
  point can be dragged in the same undo step.
- Double-click a point to switch between corner and smooth.
- With the overlay focused, Delete/Backspace removes the selected point; Escape
  deselects it. These events are consumed before timeline commands can run.

Each drag uses `app.edit.setParam(clipId, propertyId, paramId, value, { gesture,
at })` with start/update/end phases and a fixed clip-local playhead time. Animated
params write a keyframe at that time. Commands are `path.edit`, `path.deletePoint`
and `path.deselectPoint`; keybinding contributions are scoped to `path-editor`.
Path handles can be toggled in the preview's View menu. Transform handles resume
when a different property is selected or the path overlay is disabled.

Pure helpers live in `src/shared/path.ts`: `coercePath`, `clonePath`,
`interpolatePath`, `rectanglePath`, `ellipsePath`, `pathToSvg`, `pathFromSvg`,
`pathSegment`, `cubicPoint`, `insertPathPoint`, `hitPathPoint`, `hitPathSegment`,
`pathBounds`, `togglePathSmooth`. Bounds solve cubic extrema. Segment hits accept a
screen mapper and pixel tolerance. `pathFromSvg` accepts one M/L/H/V/C/Z subpath,
including relative commands and repeated coordinates; other commands and multiple
subpaths throw rather than silently dropping geometry. `path-space.ts` provides
`quadMapping` for pure projective mapping.

## Generic mask output

```ts
interface MaskBox {
  width: number
  height: number
  frame: { width: number; height: number }
}
interface MaskLayer {
  svg: string | ((box: MaskBox) => string)
  mode: 'add' | 'subtract' | 'intersect' | 'difference'
}
interface PropertyOutput {
  // Existing transform/style/contentStyle/svgFilter/etc. remain available.
  mask?: MaskLayer[]
}
```

A fragment paints **alpha** in a normalized 0..1 content viewBox; colors do not
matter. Supply trusted SVG markup, not a whole SVG document. Each fragment's IDs
and `url(#id)` / `href="#id"` references are automatically scoped to its layer.
Avoid embedded CSS ID selectors and external resources; these fragments run inside
a standalone data-URL SVG. Use presentation attributes and inline styles instead.
A callback receives the current untransformed wrapper dimensions **after** content
and shader updates. All dimensions share pixel units, so their ratios are resolution
independent. For a radius stored in frame-height fractions, use
`rx = radius * box.frame.height / box.width`, and similarly for height. Use those
values for SVG numeric filter radii. CSS lengths elsewhere still use StageUnits.

The stage concatenates layers in property order and composes one SVG mask image on
the clip wrapper. For accumulated alpha A and the next layer B:

- add: `B + A * (1 - B)`
- subtract: `A * (1 - B)`
- intersect: `A * B`
- difference: `A * (1 - B) + B * (1 - A)`

The first subtract starts from opaque. The first layer in other modes supplies the
initial alpha. Difference sums its two exclusive terms with isolated plus-lighter
compositing, preserving fractional opacity and feather. Removing all layers clears
the stage-owned mask styles. Unknown plugins contribute no layers. The mask applies
to the wrapper around every visual media type and therefore includes GPU replacement
canvases. Crop and other wrapper clipping intersect the mask; corners and border on
the content still apply. Shader passes precede CSS masks, as with other CSS effects;
property order does not interleave GPU passes with CSS output.

**Add property → Compositing → Mask** adds a centered ellipse. Shape presets,
composition mode, feather, signed expansion, opacity and invert are in its card.
The property is stackable. SVG morphology expands/erodes before Gaussian feather;
negative expansion shrinks. Morphology has an axis-aligned rectangular kernel, so
large expansion values can square off curved corners. Invert happens after feather,
then opacity scales the resulting layer. Shape, feather, expansion and opacity are
interpolatable; Mode and Invert opt in to discrete keyframes and hold until the next key.
See `examples/plugins/path-window.ts` for a dependency-free custom mask variant
using a path named `outline`; the same preview editor works without mask-specific code.

## Curve parameter and Curves property

```ts
type CurvePoint = [number, number]
interface CurveValue {
  master: CurvePoint[]
  r: CurvePoint[]
  g: CurvePoint[]
  b: CurvePoint[]
}
{ id: 'curve', label: 'Curves', type: 'curve', default: identityCurves }
```

Points are normalized input/output values. Coercion clamps, sorts and deduplicates
input positions and supplies endpoints at x=0 and x=1. Endpoint y is editable; x is
fixed. PCHIP weighted harmonic tangents provide shape-preserving monotone cubic
interpolation per interval, including curves with local extrema. Matching channel
point counts interpolate point positions between keys; a mismatch holds the whole
value. No numeric graph channels are exposed.

The inspector editor has Master/R/G/B tabs. Click to add, drag to move, drag beyond
the canvas or double-click an interior point to delete, and Reset channel to restore
identity. Drags use the same gesture and animated-param setter as other controls.

**Add property → Color → Curves** uses `ShaderEffect.textures()` and
`ShaderContext.loadTexture()` to cache a 256×1 RGBA lookup texture by a dual 32-bit
hash of the canonical value. Each channel's curve is followed by master when baking.
The fragment maps texel centers to normalized input values, samples straight sRGB,
and premultiplies RGB by the original alpha. Only pixel-capable media types offer
shader properties (currently image/video); CSS Mask works on text and shapes too.
The existing RGBA8 SDR shader precision and stage-lifetime texture caching apply.
Hue-versus-saturation curves are outside this feature.

Pure curve helpers live in `src/shared/curve.ts`: `coerceCurvePoints`, `coerceCurves`,
`defaultCurves`, `identityCurve`, `compileCurve`, `interpolateCurves`, `bakeCurves`
and `curveKey`.

## Real-app verification

1. Put an image or video over a contrasting background. Add property → Compositing
   → Mask. Confirm the centered ellipse; choose Rectangle then Ellipse and Reset.
   Click Edit on preview, drag points and the body, insert on edges, double-click to
   smooth/corner, and drag tangents with/without Alt. Delete a point and Escape;
   confirm the clip stays on the timeline. Undo/redo each drag once.
2. Animate Shape, Feather, Expansion and Opacity using each row's keyframe diamond.
   Move the playhead, edit, scrub between keys, undo/redo. Insert an extra point at
   one key; interpolation should hold until that key because topology differs.
3. Add a second and third Mask. Offset the shapes, test all four modes, fractional
   opacity, feather and invert. Reorder, toggle and remove masks, including the last
   one. Check difference with overlapping soft edges and 50% opacity.
4. Repeat on text and generated shape elements. Resize/rotate/skew/flip/tilt the
   clip and compare handles with the rendered shape at different preview qualities.
   Add Crop, Corners, Border, Transform and a shader effect on an image/video. The
   mask should stay aligned with visible pixels and the GPU replacement canvas.
5. Add Color → Curves to an image/video. Verify identity, all channel tabs, point
   insertion/movement/deletion and channel reset. Animate, reorder with other color
   effects, toggle, undo/redo, and compare transparent pixels and channel/master order.
6. Copy `path-window.ts` into the plugin folder. Add Path window and confirm its
   Outline row gets the same editing overlay. Save, unload the plugin, reopen and
   reload it; property data must remain intact.
7. Export identical frames at reference and doubled resolution. Compare feather,
   expansion, masks/crop/corners/GPU alignment and Curves output to paused preview.
   Real-app/Electron/export checks are intentionally left to the parent, serially.
