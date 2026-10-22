import { definePlugin, type ClipBodyContext, type MediaTypeContribution } from '@core/plugin-api'
import type { ThumbnailStrip } from '@shared/ipc'
import { FLICKS } from '@shared/time'
import { applyBox, fitBox, frameSeconds, MediaSync, mountOfflineSlate, type Fit } from './common'
import { FrameDecoder } from './decoder'

export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'flv', 'wmv', '3gp']

/** Video media type: native <video> in the preview, frame-exact WebCodecs decode in export. */
export const videoPlugin = definePlugin({
  id: 'cascade.media.video',
  name: 'Video',
  activate(ctx) {
    const video: MediaTypeContribution = {
      id: 'video',
      name: 'Video',
      icon: 'film',
      color: 'var(--clip-video, #e8707f)',
      track: 'visual',
      extensions: VIDEO_EXT,
      accepts: (f) => (f.meta?.hasVideo === false ? 0 : VIDEO_EXT.includes(f.ext) ? 0.8 : f.meta?.hasVideo && (f.meta.duration ?? 0) > 0 ? 0.4 : 0),
      timeBased: true,
      linkedAudioType: 'audio',
      defaultProperties: ['transform', 'opacity'],
      defaultData: () => ({ fit: 'contain' }),
      stage: {
        mount(m) {
          const src = m.mediaUrl(m.media?.proxyPath ?? m.media?.path ?? '')
          const fit = () => (m.clip.data.fit as Fit) ?? 'contain'
          if (m.mode === 'render') {
            const canvas = m.document.createElement('canvas')
            canvas.style.display = 'block'
            const decoder = new FrameDecoder(m.mediaUrl(m.media?.path ?? ''))
            let drawn = -1
            return {
              el: canvas,
              update(s) {
                applyBox(canvas, fitBox(s.media, s.project, (s.clip.data.fit as Fit) ?? 'contain'))
              },
              async prepare(s) {
                const t = Math.max(0, s.sourceTime)
                if (t === drawn) return
                const f = await decoder.frame(t)
                if (!f) return
                const c = f.canvas as HTMLCanvasElement
                if (canvas.width !== c.width || canvas.height !== c.height) {
                  canvas.width = c.width
                  canvas.height = c.height
                }
                canvas.getContext('2d')!.drawImage(c, 0, 0)
                drawn = t
              },
              dispose: () => decoder.dispose()
            }
          }
          const el = m.document.createElement('video')
          el.muted = true // sound comes from the linked audio clip
          el.preload = 'auto'
          el.playsInline = true
          el.disablePictureInPicture = true
          el.style.display = 'block'
          el.style.objectFit = 'fill'
          el.src = src
          const sync = new MediaSync(el)
          applyBox(el, fitBox(m.media, m.project, fit()))
          return {
            el,
            update(s) {
              applyBox(el, fitBox(s.media, s.project, (s.clip.data.fit as Fit) ?? 'contain'))
              sync.update(s, frameSeconds(s.project))
            },
            prepare: (s) =>
              new Promise<void>((resolve) => {
                if (Math.abs(el.currentTime - s.sourceTime) < 0.001 && el.readyState >= 2) return resolve()
                el.addEventListener('seeked', () => resolve(), { once: true })
                el.addEventListener('error', () => resolve(), { once: true }) // a missing file must not stall rendering
                el.currentTime = s.sourceTime
              }),
            dispose() {
              el.pause()
              el.removeAttribute('src')
              el.load()
            }
          }
        }
      },
      clipBody: (el, c) => mountThumbnails(el, c),
      thumbnail: (el, { media, app }) => {
        el.classList.add('media-thumb')
        if (!media.path || app.media.isOffline(media.id)) return
        void app.host?.media.poster(media.path, Math.min(1, (media.meta.duration ?? 0) / FLICKS / 3)).then((url) => {
          if (url) el.style.backgroundImage = `url("${url}")`
        })
      }
    }
    ctx.mediaTypes.register(video)
  }
})

/** Film-strip thumbnails tiled across the visible part of the clip. */
function mountThumbnails(el: HTMLElement, c: ClipBodyContext) {
  const media = c.media()
  if (!media?.path || !c.app.host) return
  const slate = mountOfflineSlate(el, c.app, media.id)
  if (slate) return slate
  let strip: ThumbnailStrip | null = null
  let disposed = false
  const layer = document.createElement('div')
  layer.className = 'clip-thumbs'
  layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;opacity:.85'
  el.appendChild(layer)
  let drawn = ''
  const draw = () => {
    if (!strip || disposed || strip.count === 0) return
    const v = c.view()
    const clip = c.clip()
    const map = c.app.edit.timeMap(clip)
    const h = v.height
    const tileW = Math.max(16, (strip.width / strip.height) * h)
    const startPx = (v.visibleStart / FLICKS) * v.pxPerSecond
    const endPx = (v.visibleEnd / FLICKS) * v.pxPerSecond
    const first = Math.floor(startPx / tileW)
    const last = Math.ceil(endPx / tileW)
    // Clip changes that don't move the tiles (most param edits) must not rebuild them.
    const key = `${first}:${last}:${tileW}:${clip.sourceIn}:${map.offset(FLICKS)}:${map.offset(clip.duration)}:${strip.count}:${v.pxPerSecond}`
    if (key === drawn) return
    drawn = key
    const frag = document.createDocumentFragment()
    for (let i = first; i < last && i - first < 400; i++) {
      const local = ((i * tileW) / v.pxPerSecond) * FLICKS
      const srcSec = (clip.sourceIn + map.offset(local)) / FLICKS
      const raw = Math.max(0, Math.floor(srcSec / strip.interval))
      if (strip.partial && raw >= strip.count) continue
      const idx = Math.min(strip.count - 1, raw)
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;top:0;bottom:0;left:${i * tileW}px;width:${tileW}px;background:center/cover no-repeat;box-shadow:inset -1px 0 rgba(0,0,0,.35);background-image:url("${strip.urlPattern.replace('{i}', String(idx))}")`
      frag.appendChild(d)
    }
    layer.replaceChildren(frag)
  }
  // Generation is incremental: poll while the main process is still extracting tiles.
  let timer: ReturnType<typeof setTimeout> | undefined
  const fetch = () =>
    void c.app.host!.media.thumbnails(media.path!, { height: 72 }).then((s) => {
      if (disposed) return
      strip = s
      draw()
      if (s?.partial) timer = setTimeout(fetch, 1000)
    })
  fetch()
  const unsub = c.subscribe(draw)
  return () => {
    disposed = true
    clearTimeout(timer)
    unsub()
    layer.remove()
  }
}
