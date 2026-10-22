import { definePlugin } from '@core/plugin-api'
import { applyBox, fitBox, type Fit } from './common'

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'bmp', 'ico', 'apng']

export const imagePlugin = definePlugin({
  id: 'cascade.media.image',
  name: 'Image',
  activate(ctx) {
    ctx.mediaTypes.register({
      id: 'image',
      name: 'Image',
      icon: 'image',
      color: 'var(--clip-image, #e3aa4a)',
      track: 'visual',
      pixels: true,
      extensions: IMAGE_EXT,
      accepts: (f) => (IMAGE_EXT.includes(f.ext) ? 0.9 : 0),
      defaultDuration: 5,
      defaultProperties: ['transform', 'opacity'],
      defaultData: () => ({ fit: 'contain' }),
      stage: {
        mount(m) {
          const el = m.document.createElement('img')
          el.crossOrigin = 'anonymous' // media:// serves CORS headers for pixel sampling
          el.decoding = 'async'
          el.draggable = false
          el.style.display = 'block'
          el.src = m.mediaUrl(m.media?.path ?? '')
          const ready = el.decode().catch(() => {})
          return {
            el,
            pixelSource: () => el,
            update(s) {
              applyBox(el, fitBox(s.media, s.project, (s.clip.data.fit as Fit) ?? 'contain'))
            },
            prepare: () => ready,
            dispose: () => el.removeAttribute('src')
          }
        }
      },
      clipBody(el, c) {
        const m = c.media()
        if (!m?.path) return
        const d = document.createElement('div')
        d.className = 'clip-thumbs clip-thumbs-image'
        d.style.backgroundImage = `url("${c.app.host?.mediaUrl(m.path)}")`
        el.appendChild(d)
        return () => d.remove()
      },
      thumbnail(el, { media, app }) {
        el.classList.add('media-thumb')
        if (media.path) el.style.backgroundImage = `url("${app.host?.mediaUrl(media.path)}")`
      }
    })
  }
})
