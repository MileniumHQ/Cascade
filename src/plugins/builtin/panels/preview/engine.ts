import type { CascadeAPI } from '@core/app'
import type { Id, MediaItem, Project } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { Disposable } from '@core/disposable'
import type { OverlayContext, Viewer, ViewerFeed } from '@core/plugin-api'
import { Emitter } from '@core/events'
import { Value } from '@core/value'
import { Stage } from '@stage/stage'
import { corners } from './overlays'
import { InputClaims } from '@core/input-claims'

const QUALITY_STEPS = [1, 0.75, 0.5, 0.375, 0.25]

/** Copy @font-face rules from the editor so the stage iframe renders the same fonts. */
function fontCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const r of Array.from(rules)) if (r instanceof CSSFontFaceRule) out.push(r.cssText.replace(/url\("?(?!data:|https?:|media:|blob:)([^")]+)"?\)/g, (_, u) => `url("${new URL(u, sheet.href ?? location.href).href}")`))
  }
  // The stage's default family name is plain 'Inter'; alias the variable build to it.
  return out.join('\n') + '\n' + out.filter((r) => r.includes('Inter Variable')).map((r) => r.replace(/'Inter Variable'|"Inter Variable"/, "'Inter'")).join('\n')
}

/** What an engine shows and how it is driven (the public contract is `ViewerFeed`). */
export type EngineFeed = ViewerFeed

const mainFeed = (app: CascadeAPI): EngineFeed => ({
  project: () => app.project(),
  timelineId: () => app.project().activeTimeline,
  time: app.playback.time,
  playing: app.playback.playing,
  rate: app.playback.rate,
  onChange: (fn) => app.doc.onChange.on(fn),
  primary: true
})

/**
 * Drives the preview: an iframe holding a Stage, rendered at an adaptive internal resolution
 * ("bite off only what it can handle") and scaled up to the display size.
 */
export class PreviewEngine implements Viewer {
  readonly iframe: HTMLIFrameElement
  stage: Stage | null = null
  audio: AudioContext | null = null
  private master: GainNode | null = null
  readonly quality = new Value(1)
  readonly onFrame = new Emitter<void>()
  /** Overlay input claims (OverlayContext.claimInput). */
  readonly claims = new InputClaims()
  private display = { width: 0, height: 0 }
  private raf = 0
  private disposers: (() => void)[] = []
  private ready: Promise<void>
  // adaptive quality bookkeeping
  private lastTick = 0
  private slow = 0
  private smooth = 0
  private interval = 1000 / 60
  private frameTimes: number[] = []
  private frameCount = 0
  private droppedCount = 0

  constructor(private app: CascadeAPI, host: HTMLElement, private feed: EngineFeed = mainFeed(app)) {
    this.iframe = document.createElement('iframe')
    this.iframe.className = 'pv-iframe'
    this.iframe.setAttribute('aria-label', 'Preview')
    this.iframe.tabIndex = -1
    host.appendChild(this.iframe)
    this.ready = new Promise((resolve) => {
      const init = () => {
        const doc = this.iframe.contentDocument!
        doc.open()
        doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
        doc.close()
        this.audio = new AudioContext({ latencyHint: 'interactive' })
        this.master = this.audio.createGain()
        this.master.connect(this.audio.destination)
        this.stage = new Stage({
          registries: app.registries,
          document: doc,
          mode: 'preview',
          mediaUrl: (p) => app.host!.mediaUrl(p),
          audio: { context: this.audio, destination: this.master, getBuffer: (media, start, duration) => decodeRange(app, this.audio!, media, start, duration) },
          css: fontCss() + '\n#cascade-stage{font-family:"Inter",system-ui,sans-serif}'
        })
        this.stage.onFrame.on(() => this.onFrame.emit())
        if (feed.primary) this.disposers.push(app.meters.provide({ read: (channel) => this.stage?.meter(channel) ?? null }))
        resolve()
      }
      init()
    })

    const req = () => this.request()
    const sub = [
      feed.time.subscribe(() => (feed.playing.get() ? this.renderNow() : this.request())),
      feed.onChange(req),
      app.registries.properties.onChange.on(req),
      app.registries.mediaTypes.onChange.on(req),
      app.registries.easings.onChange.on(req),
      feed.playing.subscribe((p) => {
        if (p) void this.audio?.resume()
        this.slow = this.smooth = 0
        this.lastTick = 0
        if (!p) this.applyQuality(this.maxQuality())
        this.request()
      }),
      app.settings.values.subscribe(() => this.applyQuality(Math.min(this.quality.get(), this.maxQuality())))
    ]
    this.disposers.push(...sub.map((d) => () => d.dispose()))
    void this.ready.then(() => this.request())
  }

  private maxQuality() {
    const r = this.app.settings.get<string>('preview.resolution')
    return r === 'quarter' ? 0.25 : r === 'half' ? 0.5 : 1
  }

  /** Size of the frame on screen (CSS px). */
  setDisplaySize(width: number, height: number) {
    this.display = { width, height }
    this.applyQuality(this.quality.get())
  }

  private applyQuality(q: number) {
    q = Math.min(q, this.maxQuality())
    this.quality.set(q)
    const { width, height } = this.display
    const s = this.iframe.style
    s.width = `${Math.max(1, Math.round(width * q))}px`
    s.height = `${Math.max(1, Math.round(height * q))}px`
    s.transform = q === 1 ? '' : `scale(${1 / q})`
  }

  request() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.renderNow()
    })
  }

  renderNow() {
    if (!this.stage) return
    const app = this.app
    const playing = this.feed.playing.get()
    this.stage.render(this.feed.project(), this.feed.timelineId(), this.feed.time.get(), { playing, rate: this.feed.rate.get() })
    if (playing) this.measure()
  }

  /** Track frame pacing while playing; step quality down on sustained drops, back up when smooth. */
  private measure() {
    const now = performance.now()
    if (this.lastTick) {
      const dt = now - this.lastTick
      this.frameTimes.push(dt)
      if (this.frameTimes.length > 30) this.frameTimes.shift()
      // Baseline = typical frame interval (25th percentile), robust to the odd back-to-back tick.
      if (this.frameTimes.length >= 10) {
        const sorted = [...this.frameTimes].sort((a, b) => a - b)
        this.interval = Math.max(1000 / 144, sorted[Math.floor(sorted.length / 4)])
      }
      const late = dt > this.interval * 1.8
      if (late) this.droppedCount++
      if (++this.frameCount % 10 === 0) {
        const fps = 1000 / (this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length)
        if (this.feed.primary) this.app.playback.stats.set({ fps: Math.round(fps), dropped: this.droppedCount })
      }
      if (!this.app.settings.get<boolean>('preview.adaptive')) return
      if (late) {
        this.slow++
        this.smooth = 0
      } else {
        this.smooth++
        this.slow = Math.max(0, this.slow - 0.25)
      }
      const i = QUALITY_STEPS.indexOf(this.quality.get())
      if (this.slow > 6 && i < QUALITY_STEPS.length - 1) {
        this.applyQuality(QUALITY_STEPS[i + 1])
        this.slow = 0
      } else if (this.smooth > 180 && i > 0) {
        this.applyQuality(QUALITY_STEPS[i - 1])
        this.smooth = 0
      }
    }
    this.lastTick = now
  }

  /** Overlay context for a layer whose box equals the displayed frame. */
  overlayContext(layer: HTMLElement): OverlayContext {
    const engine = this
    const claims = this.claims.forOverlay()
    return {
      app: this.app,
      frameRect: () => ({ x: 0, y: 0, width: layer.clientWidth, height: layer.clientHeight }),
      frameToScreen: (fx, fy) => ({ x: fx * layer.clientWidth, y: fy * layer.clientHeight }),
      screenToFrame: (x, y) => ({ x: x / layer.clientWidth, y: y / layer.clientHeight }),
      clipElement: (id) => engine.stage?.clipElement(id) ?? null,
      onFrame(fn) {
        const d = engine.onFrame.on(fn)
        const ro = new ResizeObserver(fn)
        ro.observe(layer)
        return () => {
          d.dispose()
          ro.disconnect()
        }
      },
      clipCorners: (id) => {
        const el = engine.stage?.clipElement(id)
        return el ? corners(el, engine) : null
      },
      ...claims
    }
  }

  /** Rect of a stage element in overlay (display) px. */
  rectOf(el: Element) {
    const r = el.getBoundingClientRect()
    const q = this.quality.get()
    return { x: r.x / q, y: r.y / q, width: r.width / q, height: r.height / q }
  }

  /** Topmost clip under a display-px point. */
  hitTest(x: number, y: number): string | null {
    const doc = this.iframe.contentDocument
    if (!doc) return null
    const q = this.quality.get()
    // Clips have pointer-events:none on track layers; probe each wrapper's rect instead, top-down.
    const wrappers = Array.from(doc.querySelectorAll<HTMLElement>('.cs-clip')).filter((w) => w.style.display !== 'none')
    const layers = wrappers.map((w) => ({ w, z: Number((w.parentElement as HTMLElement).style.zIndex) || 0 })).sort((a, b) => b.z - a.z)
    for (const { w } of layers) {
      const r = w.getBoundingClientRect()
      if (x * q >= r.left && x * q <= r.right && y * q >= r.top && y * q <= r.bottom) return w.dataset.clip ?? null
    }
    return null
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    for (const d of this.disposers) d()
    this.stage?.dispose()
    void this.audio?.close()
    this.iframe.remove()
  }
}

/** Decoded PCM of a source range (reverse playback in the preview), decoded by the host's ffmpeg. */
async function decodeRange(app: CascadeAPI, context: BaseAudioContext, media: MediaItem, start: number, duration: number): Promise<AudioBuffer | null> {
  if (!media.path || !app.host || duration <= 0) return null
  const pcm = await app.host.media.pcm(media.path, start, duration, context.sampleRate)
  if (!pcm?.frames) return null
  const bytes: ArrayBuffer = await (await fetch(pcm.url)).arrayBuffer()
  const data = new Float32Array(bytes)
  const frames = Math.floor(data.length / 2)
  const buffer = context.createBuffer(2, frames, pcm.sampleRate)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    left[i] = data[i * 2]
    right[i] = data[i * 2 + 1]
  }
  return buffer
}
