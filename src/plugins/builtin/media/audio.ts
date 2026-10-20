import { definePlugin, type ClipBodyContext } from '@core/plugin-api'
import { FLICKS } from '@shared/time'
import { frameSeconds, MediaSync } from './common'

export const AUDIO_EXT = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'wma', 'weba']

/**
 * Audio clips. Preview: an <audio> element routed through Web Audio so audio properties
 * (gain, pan, EQ…) apply live. Export: decoded PCM scheduled into an OfflineAudioContext chunk.
 */
export const audioPlugin = definePlugin({
  id: 'cascade.media.audio',
  name: 'Audio',
  activate(ctx) {
    ctx.mediaTypes.register({
      id: 'audio',
      name: 'Audio',
      icon: 'audio-lines',
      color: 'var(--clip-audio, #52c48e)',
      track: 'audio',
      extensions: AUDIO_EXT,
      accepts: (f) => (AUDIO_EXT.includes(f.ext) ? 0.9 : f.meta?.hasAudio && !f.meta.hasVideo ? 0.6 : 0),
      timeBased: true,
      defaultProperties: ['volume'],
      stage: {
        mount(m) {
          const audio = m.audio
          if (m.mode === 'render') {
            if (!audio) return { update() {}, dispose() {} }
            const out = audio.context.createGain()
            let scheduled: AudioBufferSourceNode | null = null
            let chunkKey = ''
            return {
              audioOut: out,
              update() {},
              async prepare(s) {
                const chunk = audio.chunk
                if (!chunk || !s.media || !audio.getBuffer) return
                const key = `${chunk.start}`
                if (key === chunkKey) return
                chunkKey = key
                const clipStart = s.clip.start / FLICKS
                const clipEnd = clipStart + s.clip.duration / FLICKS
                const from = Math.max(chunk.start, clipStart)
                const to = Math.min(chunk.start + chunk.duration, clipEnd)
                if (to <= from) return
                const speed = s.clip.speed ?? 1
                const srcFrom = s.clip.sourceIn / FLICKS + (from - clipStart) * speed
                const buf = await audio.getBuffer(s.media, srcFrom, (to - from) * speed)
                if (!buf) return
                scheduled = audio.context.createBufferSource()
                scheduled.buffer = buf
                scheduled.playbackRate.value = speed
                scheduled.connect(out)
                scheduled.start(from - chunk.start)
              },
              dispose() {
                try {
                  scheduled?.disconnect()
                } catch {}
              }
            }
          }
          const el = m.document.createElement('audio')
          el.preload = 'auto'
          el.crossOrigin = 'anonymous'
          el.src = m.mediaUrl(m.media?.proxyPath ?? m.media?.path ?? '')
          const sync = new MediaSync(el)
          let source: MediaElementAudioSourceNode | undefined
          if (audio && 'createMediaElementSource' in audio.context) {
            source = (audio.context as AudioContext).createMediaElementSource(el)
          }
          return {
            audioOut: source,
            update(s) {
              sync.update(s, frameSeconds(s.project))
            },
            dispose() {
              el.pause()
              source?.disconnect()
              el.removeAttribute('src')
              el.load()
            }
          }
        }
      },
      clipBody: (el, c) => mountWaveform(el, c),
      thumbnail(el) {
        el.classList.add('media-thumb', 'media-thumb-audio')
      }
    })
  }
})

const peakCache = new Map<string, Promise<{ rate: number; peaks: Float32Array } | null>>()

function loadPeaks(c: ClipBodyContext, path: string) {
  let p = peakCache.get(path)
  if (!p) {
    p = (async () => {
      const w = await c.app.host?.media.waveform(path)
      if (!w) return null
      const buf = await fetch(w.url).then((r) => r.arrayBuffer())
      return { rate: w.rate, peaks: new Float32Array(buf) }
    })().catch(() => null)
    peakCache.set(path, p)
  }
  return p
}

/** Waveform drawn into a canvas spanning only the visible part of the clip. */
function mountWaveform(el: HTMLElement, c: ClipBodyContext) {
  const media = c.media()
  if (!media?.path) return
  const canvas = document.createElement('canvas')
  canvas.className = 'clip-wave'
  canvas.style.cssText = 'position:absolute;top:0'
  el.appendChild(canvas)
  let data: { rate: number; peaks: Float32Array } | null = null
  let raf = 0
  const draw = () => {
    raf = 0
    if (!data) return
    const v = c.view()
    const clip = c.clip()
    const speed = clip.speed ?? 1
    const startPx = Math.floor((v.visibleStart / FLICKS) * v.pxPerSecond)
    const endPx = Math.ceil((v.visibleEnd / FLICKS) * v.pxPerSecond)
    const w = Math.max(1, Math.min(8192, endPx - startPx))
    const h = Math.max(1, v.height)
    const dpr = window.devicePixelRatio || 1
    canvas.style.left = `${startPx}px`
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const g = canvas.getContext('2d')!
    g.scale(dpr, dpr)
    g.fillStyle = getComputedStyle(el).getPropertyValue('--wave') || 'rgba(255,255,255,0.55)'
    const peaks = data.peaks
    const n = peaks.length / 2
    const mid = h / 2
    for (let x = 0; x < w; x++) {
      const s0 = clip.sourceIn / FLICKS + ((startPx + x) / v.pxPerSecond) * speed
      const s1 = clip.sourceIn / FLICKS + ((startPx + x + 1) / v.pxPerSecond) * speed
      let i0 = Math.floor(s0 * data.rate)
      const i1 = Math.max(i0 + 1, Math.floor(s1 * data.rate))
      let lo = 0
      let hi = 0
      for (; i0 < i1 && i0 < n; i0++) {
        if (i0 < 0) continue
        lo = Math.min(lo, peaks[i0 * 2])
        hi = Math.max(hi, peaks[i0 * 2 + 1])
      }
      const y0 = mid - hi * mid * 0.92
      const y1 = mid - lo * mid * 0.92
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw)
  }
  void loadPeaks(c, media.path).then((d) => {
    data = d
    schedule()
  })
  const off = c.subscribe(schedule)
  return () => {
    off()
    cancelAnimationFrame(raf)
    canvas.remove()
  }
}
