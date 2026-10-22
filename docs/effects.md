# Shader properties

Pixel effects use the public plugin API, exactly like CSS properties. Register a
`PropertyContribution` with `shader?: ShaderEffect`. See
[`examples/plugins/posterize.ts`](../examples/plugins/posterize.ts) for a complete
user plugin without runtime dependencies. Shader properties automatically appear
only on media types declaring `pixels: true`. Their instances must expose
`pixelSource?(): TexImageSource | null`, returning null until a source is ready.
Built-in video (including export decoder canvases) and images implement this.
Image/video URLs must be origin-clean (set `crossOrigin = 'anonymous'` before
assigning `src`); the media protocol supplies the corresponding CORS headers.
Unknown property IDs and their parameters remain in project documents as usual.

```ts
interface ShaderEffect {
  fragment: string
  uniforms?(values: Record<string, unknown>, ctx: ShaderContext): Record<string, number | boolean | number[]>
  textures?(values: Record<string, unknown>, ctx: ShaderContext): Record<string, ShaderTexture | Promise<ShaderTexture> | null>
}
```

The fragment is a GLSL ES 3.00 snippet defining `vec4 effect(vec2 uv)`, without a
version directive or `main`. Declare your own uniforms and samplers. The host supplies:

- `src(vec2 uv)`: clamped sampling of this pass's input; bottom-left UV origin.
- `u_resolution`: vec2 output pixel dimensions; `u_time`: float clip-local seconds.
- `straight(vec4 c)`: safely unpremultiply RGB (zero at transparent pixels).
- `srgbToLinear(vec3 c)` / `linearToSrgb(vec3 c)`: IEC sRGB transfer functions.

Input and output are **premultiplied sRGB RGBA**. Unpremultiply before color math,
convert straight RGB to linear light for exposure, luminance, saturation and grading,
then encode and multiply RGB by alpha again. Chroma-key distance and .cube lookups
use straight sRGB, matching ordinary SDR key colors and .cube input conventions.
LUTs intended for log or other transfer functions need corresponding conversion in
a plugin. Inter-pass storage is RGBA8 SDR; values outside [0,1] clamp. HDR and
wide-gamut color management are outside this contract's current implementation.
CSS transforms, crop, opacity, filters, corners and border compose after the entire
pixel chain. Shader pass order follows the clip's property list; CSS and pixel passes
are not interleaved. Preserve alpha unless intentionally keying or generating it.

Uniforms accept finite numbers/booleans as float, length 2/3/4 arrays as vecN, and
other nonempty numeric arrays as float[]. Declare boolean controls as float in GLSL.
Reserved names are `u_input`, `u_resolution`, and `u_time`. Color strings can be
converted using `shaderColor(color, 'srgb' | 'linear')`, exported from
`src/core/plugin-api.ts` and implemented in `src/shared/shader-color.ts`. It returns
straight normalized RGBA for hex/rgb[a] colors. The standalone example uses only
an erased type import, so copying it to the plugins folder requires no source imports.

`ShaderContext` supplies `resolution`, `time`, `mode`, `mediaUrl(path)` and
`loadTexture(key, load)`. Use the latter to cache one asynchronous load per immutable
key for each stage. For example, fetch `ctx.mediaUrl(path)` and parse the response;
the same media protocol is available in preview and export workers. Changing a file
at the same path requires recreating the stage/reopening the project; use a revision
in the cache key if your plugin supports live file updates. Rejected loads are cached
and logged once per property type; select a new path to retry.

`ShaderTexture` is `{ key: string, width: number, height: number, depth?: number,
data: Uint8Array | Float32Array }`. Supply tightly packed RGB or RGBA, x varying
fastest. `depth` creates a sampler3D; otherwise use sampler2D. Keys must identify
immutable texture data across all effects in a stage. Byte textures use linear
filtering; floats use nearest filtering without requiring float-filtering extensions.
Use `texelFetch` and explicit interpolation for float LUTs (the built-in LUT does
trilinear interpolation). A null or pending texture skips its whole pass in preview.
`renderExact` waits for loads after preparing media and redraws before capture.
Provide stable promises, preferably from `loadTexture`, rather than fetching per frame.

The host owns one WebGL2 context per stage and shared ping-pong buffers. Each active
clip gets a 2D canvas over its original content, which remains hidden in layout and
continues decoding. Every render updates the surface; playing videos also update on
`requestVideoFrameCallback`, and paused seeks/images update on readiness events.
Output dimensions preserve source aspect, capped by intrinsic pixels and the rendered
clip box times preview DPR (render mode uses output pixels directly). Adaptive preview
frame resizing reduces GPU work too. Declare `cost`; expensive chains additionally
use 75% spatial resolution during playback, recovering full quality when paused and
for export. No effects are omitted for performance. Unavailable WebGL2 or invalid
shaders leave the remaining chain/source usable and log once per property type.
A lost context reveals original content; recreate the stage to recover GPU processing.
Per-clip callbacks and canvases are released on unmount; shared programs, cached
textures, framebuffers and the context are released when the stage is disposed.

## Built-in controls

Add properties through the inspector's Add property menu. Color contains
Lift / Gamma / Gain, Exposure & white balance and LUT; Keying contains Chroma key
and Luma key. File parameters use the existing native dialog with `config.filters`
(`{ name, extensions }[]`), a basename label and a Clear action. File values are paths;
set `animatable: false` for static resource selection.

Chroma key measures YCbCr chroma distance, blends a soft matte, optionally erodes
edges in output pixels, and clamps the dominant key-color channel for despill.
Show matte retains source alpha. Luma key thresholds linear Rec.709 luminance;
invert swaps the removed side. Lift color is neutral at #808080, gamma/gain at white;
master controls default to 0/1/1. Temperature/tint apply relative channel exposure
adjustments rather than Kelvin calibration; contrast pivots at linear 0.18.
The LUT parser supports 2–65 point 3D .cube tables, TITLE, comments and DOMAIN_MIN/MAX;
1D/shaper LUTs are rejected. LUT intensity blends straight sRGB and preserves alpha.

## Real-app verification

1. Put a green-screen video over an image, select it, Add property → Keying → Chroma
   key. Tune tolerance/softness, check Show matte, then despill and edge shrink.
   Play, pause, seek and reverse; compare the processed frame with the decoder.
2. Add Luma key and test invert. Add both correction properties, confirm neutral
   defaults, animate exposure, reorder shader properties, toggle them, and undo/redo.
3. Add LUT, choose identity and nonidentity .cube files (including nondefault domains),
   vary intensity, Clear, select a malformed file, then select a valid different path.
   Check export workers can load the same file and wait for its first frame.
4. Apply crop, corners, border, transform, opacity and CSS blur to a keyed clip. Check
   alignment, transparency, contain/cover/fill and image inputs at preview quality
   settings and on a high-DPI screen. Export a frame and compare orientation, matte,
   color, alpha edges and full output resolution with the paused preview.
5. Add at least 20 simultaneous processed clips: verify one WebGL context per stage,
   no context-limit warning, and removal/toggling/reopening does not leave canvases or
   callbacks. Try an invalid custom shader and a WebGL-disabled session for fallback.

Eyedropper preview sampling is deferred: it needs a generic stage-sampling/interaction
API across iframe overlays and composited DOM content. Current color controls use the
existing color editor. Browser/WebGL integration is intentionally verified in the
real app, outside Vitest.
