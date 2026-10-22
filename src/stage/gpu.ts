/** Shared WebGL2 processor. Only the final 2D surfaces belong to individual clips. */
import type { ClipFrameState, ClipInstance, PropertyContribution, ShaderContext, ShaderTexture, ShaderUniform } from '@core/plugin-api'
import { FLICKS } from '@shared/time'
import { packUniform, shaderScale, shaderSize } from './gpu-utils'

export interface ShaderPass { type: string; contribution: PropertyContribution; values: Record<string, unknown> }
interface Surface {
  canvas: HTMLCanvasElement
  content: HTMLElement
  visibility: string
  passes: ShaderPass[]
  state: ClipFrameState
  inst: ClipInstance
  wrapper: HTMLElement
  video?: HTMLVideoElement
  callback?: number
  seeked?: () => void
  ready: () => void
}
interface Program { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation> }
interface TextureEntry { texture?: ShaderTexture; promise?: Promise<ShaderTexture>; error?: unknown }

const VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`
const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
in vec2 v_uv;
out vec4 outColor;
vec4 src(vec2 uv) { return texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))); }
vec3 straight(vec4 c) { return c.a > 0.000001 ? c.rgb / c.a : vec3(0.0); }
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)), step(vec3(0.04045), c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, vec3(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c)); }
`
const COPY = 'vec4 effect(vec2 uv) { return src(uv); }'

export class StageGPU {
  /** Created with the context on first use, so stages without shader effects never touch WebGL. */
  private canvas!: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private attempted = false
  private disposed = false
  private programs = new Map<string, Program | null>()
  private surfaces = new Map<string, Surface>()
  private loads = new Map<string, TextureEntry>()
  private textures = new Map<string, { texture: WebGLTexture; target: number }>()
  private warned = new Set<string>()
  private input: WebGLTexture | null = null
  private targets: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }[] = []
  private targetSize = ''

  constructor(private doc: Document, private mediaUrl: (path: string) => string) {}

  private warn(type: string, error: unknown) {
    if (this.warned.has(type)) return
    this.warned.add(type)
    console.warn(`[stage] shader ${type} skipped`, error)
  }

  private context() {
    if (!this.attempted) {
      this.attempted = true
      try {
        this.canvas = this.doc.createElement('canvas')
        this.canvas.addEventListener('webglcontextlost', () => this.redraw())
        this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false })
        if (this.gl) {
          this.input = this.makeTexture(this.gl.TEXTURE_2D)
          this.gl.disable(this.gl.BLEND)
          this.gl.pixelStorei(this.gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, this.gl.NONE)
        }
      } catch (e) { this.warn('WebGL2', e) }
      if (!this.gl) this.warn('WebGL2', 'WebGL2 unavailable')
    }
    return this.gl
  }

  private makeTexture(target: number) {
    const gl = this.gl!
    const texture = gl.createTexture()!
    gl.bindTexture(target, texture)
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    return texture
  }

  private program(fragment: string): Program | null {
    if (this.programs.has(fragment)) return this.programs.get(fragment)!
    const gl = this.gl!
    const shaders: WebGLShader[] = []
    let program: WebGLProgram | null = null
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, `${PRELUDE}\n${fragment}\nvoid main() { outColor = effect(v_uv); }`]] as const) {
        const shader = gl.createShader(type)!
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed')
      }
      program = gl.createProgram()!
      for (const shader of shaders) gl.attachShader(program, shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed')
      const uniforms = new Map<string, WebGLUniformLocation>()
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const info = gl.getActiveUniform(program, i)!
        uniforms.set(info.name.replace(/\[0\]$/, ''), gl.getUniformLocation(program, info.name)!)
      }
      const result = { program, uniforms }
      this.programs.set(fragment, result)
      return result
    } catch (e) {
      if (program) gl.deleteProgram(program)
      this.programs.set(fragment, null)
      throw e
    } finally { for (const shader of shaders) gl.deleteShader(shader) }
  }

  private uniform(p: Program, name: string, value: ShaderUniform) {
    const location = p.uniforms.get(name)
    if (!location) return
    const gl = this.gl!
    const { kind, data } = packUniform(value)
    if (kind === 'scalar') gl.uniform1f(location, data[0])
    else if (kind === 'vec2') gl.uniform2fv(location, data)
    else if (kind === 'vec3') gl.uniform3fv(location, data)
    else if (kind === 'vec4') gl.uniform4fv(location, data)
    else gl.uniform1fv(location, data)
  }

  private loadTexture = (key: string, load: () => Promise<ShaderTexture>): Promise<ShaderTexture> => {
    let entry = this.loads.get(key)
    if (!entry) {
      entry = {}
      this.loads.set(key, entry)
      entry.promise = Promise.resolve().then(load).then(texture => {
        if (!this.disposed) { entry!.texture = texture; this.redraw() }
        return texture
      }, error => { entry!.error = error; this.redraw(); throw error })
      // A paused preview may never call renderExact; still handle failed loads.
      void entry.promise.catch(() => {})
    }
    return entry.promise!
  }

  private texture(value: ShaderTexture | Promise<ShaderTexture>): ShaderTexture | null {
    if (!('then' in value)) return value
    // loadTexture promises are already tracked; arbitrary promises are tracked once as well.
    let entry = [...this.loads.values()].find(e => e.promise === value)
    if (!entry) {
      entry = { promise: value }
      this.loads.set(`promise:${this.loads.size}`, entry)
      void value.then(texture => { if (!this.disposed) { entry!.texture = texture; this.redraw() } }, error => { entry!.error = error; this.redraw() })
    }
    if (entry.error) throw entry.error
    return entry.texture ?? null
  }

  private bindTexture(desc: ShaderTexture, unit: number) {
    const gl = this.gl!
    let cached = this.textures.get(desc.key)
    const target = desc.depth ? gl.TEXTURE_3D : gl.TEXTURE_2D
    gl.activeTexture(gl.TEXTURE0 + unit)
    if (!cached) {
      const channels = desc.data.length / (desc.width * desc.height * (desc.depth ?? 1))
      if (![3, 4].includes(channels)) throw new Error('Texture data must contain RGB or RGBA pixels')
      const max = gl.getParameter(desc.depth ? gl.MAX_3D_TEXTURE_SIZE : gl.MAX_TEXTURE_SIZE) as number
      if ([desc.width, desc.height, desc.depth ?? 1].some(n => !Number.isInteger(n) || n < 1 || n > max)) throw new Error('Invalid texture dimensions')
      const texture = this.makeTexture(target)
      const float = desc.data instanceof Float32Array
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      const format = channels === 3 ? gl.RGB : gl.RGBA
      const internal = float ? (channels === 3 ? gl.RGB32F : gl.RGBA32F) : (channels === 3 ? gl.RGB8 : gl.RGBA8)
      if (float) {
        // Float linear filtering requires an optional extension. Shader authors interpolate 3D LUTs.
        gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      }
      if (desc.depth) gl.texImage3D(target, 0, internal, desc.width, desc.height, desc.depth, 0, format, float ? gl.FLOAT : gl.UNSIGNED_BYTE, desc.data)
      else gl.texImage2D(target, 0, internal, desc.width, desc.height, 0, format, float ? gl.FLOAT : gl.UNSIGNED_BYTE, desc.data)
      cached = { texture, target }
      this.textures.set(desc.key, cached)
    }
    gl.bindTexture(cached.target, cached.texture)
  }

  private resize(width: number, height: number) {
    const gl = this.gl!
    const key = `${width}:${height}`
    if (key === this.targetSize) return
    this.canvas.width = width; this.canvas.height = height
    for (const t of this.targets) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer) }
    this.targets = []
    for (let i = 0; i < 2; i++) {
      const texture = this.makeTexture(gl.TEXTURE_2D)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const framebuffer = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      this.targets.push({ texture, framebuffer })
    }
    this.targetSize = key
  }

  update(id: string, inst: ClipInstance, wrapper: HTMLElement, state: ClipFrameState, passes: ShaderPass[], visible: boolean) {
    if (!visible || !passes.length || !inst.pixelSource || !inst.el) { this.remove(id); return }
    if (!this.context()) {
      for (const pass of passes) this.warn(pass.type, 'WebGL2 unavailable')
      this.remove(id)
      return
    }
    let surface = this.surfaces.get(id)
    if (!surface) {
      const canvas = this.doc.createElement('canvas')
      canvas.className = 'cs-gpu-output'
      surface = { canvas, content: inst.el, visibility: inst.el.style.visibility, passes, state, inst, wrapper, ready: () => this.draw(surface!) }
      inst.el.addEventListener('load', surface.ready)
      inst.el.addEventListener('loadeddata', surface.ready)
      // Original media remains in flow, preserving the wrapper's sizing and video decoding.
      wrapper.appendChild(canvas)
      this.surfaces.set(id, surface)
    }
    Object.assign(surface, { passes, state, inst, wrapper })
    this.draw(surface)
    this.watch(surface)
  }

  private watch(s: Surface) {
    const source = s.inst.pixelSource?.()
    const video = source && 'requestVideoFrameCallback' in source ? source as HTMLVideoElement : undefined
    if (s.video !== video) {
      this.unwatch(s)
      s.video = video
      if (video) { s.seeked = () => this.draw(s); video.addEventListener('seeked', s.seeked) }
    }
    if (!s.state.playing) {
      if (s.callback !== undefined) video?.cancelVideoFrameCallback(s.callback)
      s.callback = undefined
    } else if (video && s.callback === undefined) {
      s.callback = video.requestVideoFrameCallback(() => {
        s.callback = undefined
        if (!this.disposed) { this.draw(s); this.watch(s) }
      })
    }
  }

  private unwatch(s: Surface) {
    if (s.callback !== undefined) s.video?.cancelVideoFrameCallback(s.callback)
    if (s.seeked) s.video?.removeEventListener('seeked', s.seeked)
    s.callback = undefined; s.seeked = undefined; s.video = undefined
  }

  private draw(s: Surface) {
    const gl = this.gl
    if (!gl || this.disposed) return
    if (gl.isContextLost()) { s.content.style.visibility = s.visibility; s.canvas.style.visibility = 'hidden'; return }
    const source = s.inst.pixelSource?.()
    if (!source || ('readyState' in source && source.readyState < 2)) return
    const size = intrinsicSize(source)
    if (!size.width || !size.height) return
    try {
      const rect = s.wrapper.getBoundingClientRect()
      const box = rect.width && rect.height ? rect : s.state.u.frame
      const dpr = s.state.mode === 'render' ? 1 : this.doc.defaultView?.devicePixelRatio ?? 1
      const output = shaderSize(size, box, dpr, shaderScale(s.passes.map(p => p.contribution.cost), s.state.mode, s.state.playing), gl.getParameter(gl.MAX_TEXTURE_SIZE))
      this.resize(output.width, output.height)
      gl.viewport(0, 0, output.width, output.height)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.input)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      let input = this.input
      let index = 0
      const ctx: ShaderContext = { resolution: output, time: s.state.local / FLICKS, mode: s.state.mode, mediaUrl: this.mediaUrl, loadTexture: this.loadTexture }
      for (const pass of s.passes) {
        try {
          const effect = pass.contribution.shader!
          const p = this.program(effect.fragment)
          if (!p) { this.warn(pass.type, 'Shader compile/link failed'); continue }
          const extras = Object.entries(effect.textures?.(pass.values, ctx) ?? {})
          const resolved = extras.map(([name, texture]) => [name, texture ? this.texture(texture) : null] as const)
          if (resolved.some(([, texture]) => !texture)) continue
          if (resolved.length + 1 > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) throw new Error('Too many shader textures')
          gl.useProgram(p.program)
          this.uniform(p, 'u_resolution', [output.width, output.height])
          this.uniform(p, 'u_time', ctx.time)
          for (const [name, value] of Object.entries(effect.uniforms?.(pass.values, ctx) ?? {})) this.uniform(p, name, value)
          resolved.forEach(([name, texture], i) => { this.bindTexture(texture!, i + 1); gl.uniform1i(p.uniforms.get(name) ?? null, i + 1) })
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, input)
          gl.uniform1i(p.uniforms.get('u_input') ?? null, 0)
          const target = this.targets[index]
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          input = target.texture
          index = 1 - index
        } catch (e) { this.warn(pass.type, e) }
      }
      const copy = this.program(COPY)!
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.useProgram(copy.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input)
      gl.uniform1i(copy.uniforms.get('u_input') ?? null, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const canvas = s.canvas
      if (canvas.width !== output.width || canvas.height !== output.height) { canvas.width = output.width; canvas.height = output.height }
      const context = canvas.getContext('2d')!
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(this.canvas, 0, 0)
      // Copy all content CSS (border, corners, object-fit…) while keeping layout in the original.
      canvas.style.cssText = s.content.style.cssText
      canvas.style.position = 'absolute'
      canvas.style.left = '0'; canvas.style.top = '0'
      canvas.style.visibility = s.visibility
      // Canvas intrinsic ratio follows the source; explicit media dimensions govern its box.
      if (!canvas.style.width) canvas.style.width = '100%'
      if (!canvas.style.height) canvas.style.height = '100%'
      s.content.style.visibility = 'hidden'
    } catch (e) {
      s.content.style.visibility = s.visibility
      s.canvas.style.visibility = 'hidden'
      this.warn('source', e)
    }
  }

  private redraw() { if (!this.disposed) for (const s of this.surfaces.values()) this.draw(s) }

  /** Called after media prepare; discovers async textures, waits, then draws the exact pixels. */
  async renderExact() {
    this.redraw()
    await Promise.allSettled([...this.loads.values()].map(e => e.promise))
    this.redraw()
  }

  remove(id: string) {
    const s = this.surfaces.get(id)
    if (!s) return
    this.unwatch(s)
    s.content.removeEventListener('load', s.ready)
    s.content.removeEventListener('loadeddata', s.ready)
    s.content.style.visibility = s.visibility
    s.canvas.remove()
    this.surfaces.delete(id)
  }

  dispose() {
    this.disposed = true
    for (const id of this.surfaces.keys()) this.remove(id)
    const gl = this.gl
    if (gl) {
      for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program)
      for (const t of this.textures.values()) gl.deleteTexture(t.texture)
      for (const t of this.targets) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer) }
      gl.deleteTexture(this.input)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.programs.clear(); this.textures.clear(); this.loads.clear(); this.targets = []
  }
}

function intrinsicSize(source: TexImageSource): { width: number; height: number } {
  if ('videoWidth' in source) return { width: source.videoWidth, height: source.videoHeight }
  if ('naturalWidth' in source) return { width: source.naturalWidth, height: source.naturalHeight }
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight }
  return { width: source.width, height: source.height }
}
