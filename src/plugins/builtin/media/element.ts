import { definePlugin } from '@core/plugin-api'

/**
 * Elements are DOM boxes with no file behind them: text, solid colors, shapes.
 * Their look comes entirely from properties (Text, Fill, Size, Corners, Border, Shadow…),
 * which write styles and `extra` values the element applies here.
 */
export const elementPlugin = definePlugin({
  id: 'cascade.media.element',
  name: 'Element',
  activate(ctx) {
    ctx.mediaTypes.register({
      id: 'element',
      name: 'Element',
      icon: 'square-dashed-mouse-pointer',
      color: 'var(--clip-element, #ad9cf2)',
      track: 'visual',
      defaultDuration: 5,
      defaultProperties: ['transform', 'opacity'],
      stage: {
        mount(m) {
          const el = m.document.createElement('div')
          el.className = 'cs-element'
          el.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;white-space:pre-wrap;'
          let text: string | undefined
          return {
            el,
            update(s) {
              const t = s.extra.text as string | undefined
              if (t !== text) {
                text = t
                el.textContent = t ?? ''
              }
            },
            dispose() {}
          }
        }
      },
      clipBody(el, c) {
        const d = document.createElement('div')
        d.className = 'clip-element-body'
        d.style.cssText = 'position:absolute;inset:0;padding:3px 6px;font-size:11px;color:rgba(255,255,255,.6);overflow:hidden;white-space:nowrap;text-overflow:ellipsis'
        const draw = () => {
          const clip = c.clip()
          const text = clip.properties.find((p) => p.type === 'text')?.params.text?.value
          d.textContent = typeof text === 'string' ? text : ''
        }
        draw()
        el.appendChild(d)
        const off = c.subscribe(draw)
        return () => {
          off()
          d.remove()
        }
      }
    })

    ctx.generators.register({
      id: 'text',
      name: 'Text',
      description: 'A text box with font, size and color',
      icon: 'type',
      mediaType: 'element',
      create: () => ({ name: 'Text', clipData: { kind: 'text' }, properties: [{ type: 'transform' }, { type: 'text' }] })
    })
    ctx.generators.register({
      id: 'solid',
      name: 'Solid color',
      description: 'A full-frame color fill',
      icon: 'paint-bucket',
      mediaType: 'element',
      create: () => ({ name: 'Solid', clipData: { kind: 'solid' }, properties: [{ type: 'transform' }, { type: 'size', values: { size: [1, 1] } }, { type: 'fill' }] })
    })
    ctx.generators.register({
      id: 'shape',
      name: 'Shape',
      description: 'A rectangle with corners, border and shadow',
      icon: 'square',
      mediaType: 'element',
      create: (project) => ({
        name: 'Shape',
        clipData: { kind: 'shape' },
        // Square: 30% of the frame height on both axes, whatever the aspect ratio.
        properties: [{ type: 'transform' }, { type: 'size', values: { size: [0.3 * (project.settings.height / project.settings.width), 0.3] } }, { type: 'fill', values: { color: '#c6f24e' } }, { type: 'corners' }]
      })
    })
  }
})
