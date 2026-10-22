/**
 * The Stage turns (project, time) into DOM. It runs inside the preview iframe and inside the
 * headless export workers — same code, so what you see is what you export.
 *
 * Nothing here knows about specific media types or properties: clips are mounted by their
 * media type plugin, and properties contribute CSS fragments that the stage composes.
 *
 * Resolution independence: the stage root is a size container, plugins express lengths with
 * container units (cqw/cqh) via `StageUnits`, so the same DOM renders at any output size.
 */
import { anySolo, trackAudible, type MeterReading } from '@shared/audio-mix'
import { StageMixer } from './mixer'
import { clipEnd, type Clip, type Id, type MediaItem, type Project, type Track } from '@shared/project'
import { FLICKS, type Flicks } from '@shared/time'
import type { Registries } from '@core/app'
import { evaluateProperty } from '@core/evaluate'
import { clipTimeMap } from '@core/time-remap'
import { Emitter } from '@core/events'
import { StageGPU, type ShaderPass } from './gpu'
import { clipRenderRange, transitionGain, renderTransitionLayers } from './transitions'
import { applyMasks } from './masks'
import type {
  AudioPropertyNode,
  ClipFrameState,
  ClipInstance,
  PropertyContribution,
  PropertyOutput,
  StageAudio,
  StageUnits
} from '@core/plugin-api'

export interface StageOptions {
  registries: Registries
  document: Document
  mode: 'preview' | 'render'
  mediaUrl(path: string): string
  audio?: StageAudio
  /** CSS injected into the stage document (fonts…). */
  css?: string
}

interface AudioChain {
  signature: string
  nodes: { inst: Id; type: string; node: AudioPropertyNode }[]
  gain: GainNode
}

interface Mounted {
  clip: Clip
  trackId: Id
  mediaKey: string
  inst: ClipInstance
  wrapper: HTMLElement
  layer: HTMLElement
  styleKeys: Set<string>
  contentKeys: Set<string>
  svgFilterKey?: string
  audio?: AudioChain
  lastState?: ClipFrameState
  visible: boolean
}

const PREROLL_PREVIEW = 1.5 * FLICKS
const POSTROLL_PREVIEW = 0.5 * FLICKS

export class Stage {
  readonly root: HTMLElement
  private trackLayers = new Map<Id, HTMLElement>()
  private mounted = new Map<Id, Mounted>()
  private svgDefs: SVGDefsElement
  private project: Project | null = null
  private timelineId: Id | null = null
  readonly units: StageUnits
  private frameSize = { width: 1920, height: 1080 }
  private resizeObs: ResizeObserver | null = null
  readonly onFrame = new Emitter<Flicks>()
  private lastTime = 0
  private lastPlaying = false
  private lastRate = 1
  private disposed = false
  /** Track buses and the master bus every clip chain feeds (absent without audio). */
  private mixer: StageMixer | null
  private gpu: StageGPU

  constructor(private opts: StageOptions) {
    const doc = opts.document
    this.mixer = opts.audio ? new StageMixer(opts.audio) : null
    this.gpu = new StageGPU(doc, opts.mediaUrl)
    const style = doc.createElement('style')
    style.textContent = `
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      #cascade-stage { position: absolute; inset: 0; overflow: hidden; container-type: size; contain: strict;
        font-family: 'Inter', system-ui, sans-serif; color: white; -webkit-font-smoothing: antialiased; }
      .cs-track { position: absolute; inset: 0; pointer-events: none; }
      .cs-clip-layer { position: absolute; inset: 0; transform-origin: 50% 50%; }
      .cs-clip { position: absolute; left: 50%; top: 50%; transform-origin: 50% 50%; will-change: transform; }
      ${opts.css ?? ''}
    `
    doc.head.appendChild(style)
    this.root = doc.createElement('div')
    this.root.id = 'cascade-stage'
    doc.body.appendChild(this.root)
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    this.svgDefs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs')
    svg.appendChild(this.svgDefs)
    doc.body.appendChild(svg)

    const self = this
    this.units = {
      x: (v) => `${+(v * 100).toFixed(4)}cqw`,
      y: (v) => `${+(v * 100).toFixed(4)}cqh`,
      len: (v) => `${+(v * 100).toFixed(4)}cqh`,
      get frame() {
        return self.frameSize
      }
    }
    const win = doc.defaultView
    if (win && 'ResizeObserver' in win) {
      this.resizeObs = new (win as typeof window).ResizeObserver(() => {
        this.measure()
        if (this.project) this.render(this.project, this.timelineId!, this.lastTime, { playing: this.lastPlaying, rate: this.lastRate })
      })
      this.resizeObs.observe(this.root)
    }
    this.measure()
  }

  private measure() {
    const r = this.root.getBoundingClientRect()
    if (r.width && r.height) this.frameSize = { width: r.width, height: r.height }
  }

  get frame() {
    return this.frameSize
  }

  clipElement(id: Id): HTMLElement | null {
    const m = this.mounted.get(id)
    return m?.visible ? m.wrapper : null
  }

  private layerFor(track: Track, z: number): HTMLElement {
    let el = this.trackLayers.get(track.id)
    if (!el) {
      el = this.opts.document.createElement('div')
      el.className = 'cs-track'
      el.dataset.track = track.id
      this.root.appendChild(el)
      this.trackLayers.set(track.id, el)
    }
    el.style.zIndex = String(z)
    el.style.display = track.hidden ? 'none' : ''
    return el
  }

  private mediaKey(clip: Clip, media?: MediaItem) {
    return `${clip.type}|${clip.mediaId ?? ''}|${media?.proxyPath ?? media?.path ?? ''}`
  }

  private mount(clip: Clip, track: Track, project: Project): Mounted | null {
    const mt = this.opts.registries.mediaTypes.get(clip.type)
    if (!mt) return null
    const media = clip.mediaId ? project.media[clip.mediaId] : undefined
    const wrapper = this.opts.document.createElement('div')
    wrapper.className = 'cs-clip'
    wrapper.dataset.clip = clip.id
    const layer = this.opts.document.createElement('div')
    layer.className = 'cs-clip-layer'
    layer.appendChild(wrapper)
    let inst: ClipInstance
    try {
      inst = mt.stage.mount({
        clip,
        media,
        project,
        document: this.opts.document,
        mode: this.opts.mode,
        u: this.units,
        mediaUrl: this.opts.mediaUrl,
        audio: this.opts.audio
      })
    } catch (e) {
      console.error(`[stage] mount failed for ${clip.type}`, e)
      return null
    }
    if (inst.el) wrapper.appendChild(inst.el)
    if (track.kind === 'visual') (this.trackLayers.get(track.id) ?? this.layerFor(track, 0)).appendChild(layer)
    return {
      clip,
      trackId: track.id,
      mediaKey: this.mediaKey(clip, media),
      inst,
      wrapper,
      layer,
      styleKeys: new Set(),
      contentKeys: new Set(),
      visible: false
    }
  }

  private unmount(m: Mounted) {
    this.gpu.remove(m.clip.id)
    try {
      m.inst.dispose()
    } catch (e) {
      console.error(e)
    }
    this.disposeAudio(m)
    m.layer.remove()
    if (m.svgFilterKey) this.svgDefs.querySelector(`#${CSS.escape(`f_${m.clip.id}`)}`)?.remove()
  }

  private disposeAudio(m: Mounted) {
    if (!m.audio) return
    for (const n of m.audio.nodes) {
      try {
        n.node.dispose?.()
        n.node.output.disconnect()
      } catch {}
    }
    try {
      m.audio.gain.disconnect()
    } catch {}
    m.audio = undefined
  }

  /** (Re)build the Web Audio chain: source → property nodes → gain → destination. */
  private syncAudio(m: Mounted, clip: Clip, track: Track, at: number, values: Map<Id, Record<string, unknown>>, gain = 1) {
    const audio = this.opts.audio
    const src = (m.inst as ClipInstance & { audioOut?: AudioNode }).audioOut
    if (!audio || !src) return
    const props = clip.properties.filter((p) => p.enabled && this.opts.registries.properties.get(p.type)?.audio)
    const sig = props.map((p) => `${p.id}:${p.type}`).join(',')
    if (!m.audio || m.audio.signature !== sig) {
      this.disposeAudio(m)
      try {
        src.disconnect()
      } catch {}
      const ctx = audio.context
      const nodes: AudioChain['nodes'] = []
      let prev: AudioNode = src
      for (const p of props) {
        const contrib = this.opts.registries.properties.get(p.type)!
        const node = contrib.audio!.create(ctx, values.get(p.id) ?? {})
        prev.connect(node.input)
        prev = node.output
        nodes.push({ inst: p.id, type: p.type, node })
      }
      const gain = ctx.createGain()
      prev.connect(gain)
      gain.connect(this.mixer ? this.mixer.input(track) : audio.destination)
      m.audio = { signature: sig, nodes, gain }
    }
    m.audio.gain.gain.setValueAtTime(track.muted ? 0 : gain, at)
    for (const n of m.audio.nodes) {
      const v = values.get(n.inst)
      if (v) n.node.update(v, at)
    }
  }

  /**
   * Render the frame at time t. Synchronous: styles are applied immediately; media elements
   * catch up asynchronously (use `prepare` in render mode to wait for exact frames).
   */
  render(project: Project, timelineId: Id, t: Flicks, o: { playing: boolean; rate?: number }) {
    if (this.disposed) return
    this.project = project
    this.timelineId = timelineId
    this.lastTime = t
    this.lastPlaying = o.playing
    this.lastRate = o.rate ?? 1
    const tl = project.timelines[timelineId]
    if (!tl) return
    this.root.style.background = project.settings.background
    const preroll = this.opts.mode === 'preview' ? PREROLL_PREVIEW : 0
    const postroll = this.opts.mode === 'preview' ? POSTROLL_PREVIEW : 0
    const needed = new Set<Id>()
    this.mixer?.sync(tl.tracks)
    let z = 0
    const liveTracks = new Set<Id>()
    for (const track of tl.tracks) {
      liveTracks.add(track.id)
      if (track.kind === 'visual') this.layerFor(track, ++z)
      for (const clip of track.clips) {
        const range = clipRenderRange(this.opts.registries, track, clip)
        if (range.start - preroll > t || range.end + postroll <= t) continue
        needed.add(clip.id)
        this.renderClip(project, track, clip, t, o)
      }
      if (track.kind === 'visual') {
        const layers = new Map<Id, HTMLElement>()
        track.clips.forEach((clip, index) => {
          const m = this.mounted.get(clip.id)
          if (m) { m.layer.style.zIndex = String(index); layers.set(clip.id, m.layer) }
        })
        if (layers.size) renderTransitionLayers(this.opts.registries, track, t, layers, { u: this.units, mode: this.opts.mode, project })
      }
    }
    for (const [id, m] of this.mounted) {
      if (!needed.has(id)) {
        this.unmount(m)
        this.mounted.delete(id)
      }
    }
    for (const [id, el] of this.trackLayers) {
      if (!liveTracks.has(id)) {
        el.remove()
        this.trackLayers.delete(id)
      }
    }
    this.onFrame.emit(t)
  }

  private renderClip(project: Project, track: Track, clip: Clip, t: Flicks, o: { playing: boolean; rate?: number }) {
    const media = clip.mediaId ? project.media[clip.mediaId] : undefined
    let m = this.mounted.get(clip.id)
    if (m && (m.mediaKey !== this.mediaKey(clip, media) || m.trackId !== track.id)) {
      this.unmount(m)
      this.mounted.delete(clip.id)
      m = undefined
    }
    if (!m) {
      const created = this.mount(clip, track, project)
      if (!created) return
      m = created
      this.mounted.set(clip.id, m)
    }
    m.clip = clip
    const range = clipRenderRange(this.opts.registries, track, clip)
    const visible = t >= range.start && t < range.end && !(track.kind === 'visual' && track.hidden)
    const local = Math.max(range.start - clip.start, Math.min(t - clip.start, range.end - clip.start))
    const remap = clipTimeMap(clip, project.timelines[this.timelineId ?? project.activeTimeline], this.opts.registries)
    const source = clip.sourceIn + remap.offset(local)
    const sourceEnd = media?.meta.duration ?? Infinity
    const state: ClipFrameState = {
      time: t,
      local,
      sourceTime: Math.max(0, Math.min(Math.max(0, sourceEnd - 1), source)) / FLICKS,
      activeRange: range,
      playing: o.playing && visible && source >= 0 && source < sourceEnd,
      rate: (o.rate ?? 1) * remap.speedAt(local) * (remap.reversed ? -1 : 1),
      remap,
      clip,
      media,
      project,
      mode: this.opts.mode,
      extra: {},
      u: this.units
    }

    // ── properties ──
    const out: Required<Pick<PropertyOutput, 'transform' | 'filter' | 'backdropFilter'>> & {
      style: Record<string, string>
      contentStyle: Record<string, string>
      masks: NonNullable<PropertyOutput['mask']>
      svg: string[]
    } = { transform: [], filter: [], backdropFilter: [], style: {}, contentStyle: {}, svg: [], masks: [] }
    const shaderPasses: ShaderPass[] = []
    const audioValues = new Map<Id, Record<string, unknown>>()
    const applied = new Set<string>()
    for (const p of clip.properties) {
      if (!p.enabled) continue
      const contrib: PropertyContribution | undefined = this.opts.registries.properties.get(p.type)
      if (!contrib) continue
      let values: Record<string, unknown>
      try {
        values = evaluateProperty(this.opts.registries, contrib, p, local)
      } catch (e) {
        console.error(e)
        continue
      }
      if (contrib.audio) audioValues.set(p.id, values)
      if (contrib.shader && track.kind === 'visual') shaderPasses.push({ type: p.type, contribution: contrib, values })
      if (!contrib.apply || track.kind !== 'visual') continue
      let r: PropertyOutput | void
      applied.add(p.type)
      try {
        r = contrib.apply(values, {
          u: this.units,
          clip,
          media,
          local,
          mode: this.opts.mode,
          playing: o.playing,
          project,
          elements: { wrapper: m.wrapper, content: m.inst.el ?? null, document: this.opts.document }
        })
      } catch (e) {
        console.error(`[stage] property ${p.type} failed`, e)
        continue
      }
      if (!r) continue
      if (r.transform) out.transform.push(...r.transform)
      if (r.filter) out.filter.push(...r.filter)
      if (r.backdropFilter) out.backdropFilter.push(...r.backdropFilter)
      if (r.style) Object.assign(out.style, r.style)
      if (r.contentStyle) Object.assign(out.contentStyle, r.contentStyle)
      if (r.svgFilter) out.svg.push(r.svgFilter)
      if (r.mask) out.masks.push(...r.mask)
      if (r.extra) Object.assign(state.extra, r.extra)
    }

    if (track.kind === 'visual') {
      const w = m.wrapper
      m.layer.style.display = visible ? '' : 'none'
      // Escape-hatch DOM added by properties is tagged data-cs-owner="<type>"; drop it once that property stops applying.
      if (w.childElementCount > 1)
        for (const el of w.querySelectorAll<HTMLElement>(':scope > [data-cs-owner]')) if (!applied.has(el.dataset.csOwner!)) el.remove()
      if (out.svg.length) {
        const key = out.svg.join('')
        const id = `f_${clip.id}`
        if (m.svgFilterKey !== key) {
          let f = this.svgDefs.querySelector(`#${CSS.escape(id)}`)
          if (!f) {
            f = this.opts.document.createElementNS('http://www.w3.org/2000/svg', 'filter')
            f.id = id
            f.setAttribute('color-interpolation-filters', 'sRGB')
            f.setAttribute('x', '-50%')
            f.setAttribute('y', '-50%')
            f.setAttribute('width', '200%')
            f.setAttribute('height', '200%')
            this.svgDefs.appendChild(f)
          }
          f.innerHTML = key
          m.svgFilterKey = key
        }
        out.filter.push(`url(#${id})`)
      }
      const style: Record<string, string> = {
        transform: `translate(-50%, -50%) ${out.transform.join(' ')}`.trim(),
        filter: out.filter.join(' '),
        'backdrop-filter': out.backdropFilter.join(' '),
        ...out.style
      }
      applyStyles(w, style, m.styleKeys)
      if (m.inst.el) applyStyles(m.inst.el, out.contentStyle, m.contentKeys)
    }

    if (visible || this.opts.mode === 'preview') {
      try {
        m.inst.update(state)
      } catch (e) {
        console.error(`[stage] update failed for ${clip.type}`, e)
      }
    }
    this.gpu.update(clip.id, m.inst, m.wrapper, state, shaderPasses, visible)
    if (track.kind === 'visual') applyMasks(m.wrapper, out.masks, this.frameSize)
    if (this.opts.audio) this.syncAudio(m, clip, track, this.opts.audio.context.currentTime, audioValues, visible ? transitionGain(this.opts.registries, track, clip, t) : 0)
    m.visible = visible
    m.lastState = state
  }

  /** Render mode: render and wait until every visible clip has its exact content on screen. */
  async renderExact(project: Project, timelineId: Id, t: Flicks) {
    this.render(project, timelineId, t, { playing: false })
    const waits: Promise<void>[] = []
    for (const m of this.mounted.values()) {
      if (m.visible && m.inst.prepare && m.lastState) waits.push(m.inst.prepare(m.lastState).catch((e) => console.error(e)))
    }
    await Promise.all(waits)
    await this.gpu.renderExact()
    await this.opts.document.fonts?.ready
  }

  /**
   * Offline audio pass: mount every overlapping clip, including clips starting mid-chunk.
   * A fresh stage/context per chunk bounds memory. The caller starts OfflineAudioContext rendering.
   */
  async renderAudioChunk(project: Project, timelineId: Id, start: Flicks, duration: Flicks) {
    const audio = this.opts.audio
    const timeline = project.timelines[timelineId]
    if (!audio?.chunk || !timeline) throw new Error('Audio chunk requires a timeline and StageAudio.chunk')
    const end = start + duration
    const prepare: Promise<void>[] = []
    this.mixer?.sync(timeline.tracks, 0)
    const solo = anySolo(timeline.tracks)
    for (const track of timeline.tracks) {
      if (!trackAudible(track, solo)) continue
      for (const clip of track.clips) {
        const range = clipRenderRange(this.opts.registries, track, clip)
        if (range.start >= end || range.end <= start) continue
        const mounted = this.mount(clip, track, project)
        if (!mounted) throw new Error(`Cannot mount audio clip ${clip.id} (${clip.type})`)
        this.mounted.set(clip.id, mounted)
        // Media plugins expose audio capability through their mounted instance, never a core type list.
        if (!mounted.inst.audioOut) {
          this.unmount(mounted)
          this.mounted.delete(clip.id)
          continue
        }
        const from = Math.max(start, range.start)
        const to = Math.min(end, range.end)
        const props = clip.properties.filter(p => p.enabled && this.opts.registries.properties.get(p.type)?.audio)
        const step = FLICKS / 100
        // Schedule transition gain at 100 Hz; gate only outside the extended range.
        for (let t = from; ; t = Math.min(to, t + step)) {
          const values = new Map<Id, Record<string, unknown>>()
          for (const p of props) {
            const contribution = this.opts.registries.properties.get(p.type)!
            values.set(p.id, evaluateProperty(this.opts.registries, contribution, p, Math.round(t - clip.start)))
          }
          this.syncAudio(mounted, clip, track, (t - start) / FLICKS, values, transitionGain(this.opts.registries, track, clip, t))
          if (t >= to) break
        }
        // Gate decoded buffers at clip boundaries, even when resampling rounds up a sample.
        if (from > start) mounted.audio!.gain.gain.setValueAtTime(0, 0)
        mounted.audio!.gain.gain.setValueAtTime(0, (to - start) / FLICKS)
        for (const n of mounted.audio!.nodes) if (n.node.ready) prepare.push(n.node.ready)
        const local = from - clip.start
        const remap = clipTimeMap(clip, timeline, this.opts.registries)
        const media = clip.mediaId ? project.media[clip.mediaId] : undefined
        const state: ClipFrameState = {
          time: from, local, activeRange: range, sourceTime: Math.max(0, Math.min(Math.max(0, (media?.meta.duration ?? Infinity) - 1), clip.sourceIn + remap.offset(local))) / FLICKS,
          playing: false, rate: remap.speedAt(local) * (remap.reversed ? -1 : 1), remap, clip, media,
          project, mode: 'render', extra: {}, u: this.units
        }
        mounted.inst.update(state)
        if (mounted.inst.prepare) prepare.push(mounted.inst.prepare(state))
      }
    }
    await Promise.all(prepare)
  }

  /** Peak/RMS taps for the mixer: `master` or `track:<id>` (see shared/audio-mix). Null without audio or for unknown channels. */
  meter(channel: string): MeterReading | null {
    return this.mixer?.meter(channel) ?? null
  }

  /** All currently mounted clip ids (for overlays/tests). */
  mountedClips() {
    return [...this.mounted.keys()]
  }

  dispose() {
    this.disposed = true
    for (const m of this.mounted.values()) this.unmount(m)
    this.mounted.clear()
    this.mixer?.dispose()
    this.gpu.dispose()
    this.resizeObs?.disconnect()
    this.root.remove()
  }
}

function applyStyles(el: HTMLElement, styles: Record<string, string>, prevKeys: Set<string>) {
  const next = new Set<string>()
  for (const [k, v] of Object.entries(styles)) {
    if (v === '' || v === undefined || v === null) continue
    next.add(k)
    if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v)
  }
  for (const k of prevKeys) if (!next.has(k)) el.style.removeProperty(k)
  prevKeys.clear()
  for (const k of next) prevKeys.add(k)
}
