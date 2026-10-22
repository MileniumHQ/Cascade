import { definePlugin } from '@core/plugin-api'

/** Text content; with `rest`, lines after the first get their own size, weight and opacity. */
function renderText(el: HTMLElement, text: string, rest?: { size: number; weight: number; opacity: number }) {
  const nl = text.indexOf('\n')
  if (!rest || nl < 0) {
    el.textContent = text
    return
  }
  const first = el.ownerDocument.createElement('span')
  first.textContent = text.slice(0, nl)
  const later = el.ownerDocument.createElement('span')
  later.textContent = text.slice(nl)
  later.style.cssText = `font-size:${rest.size}em;opacity:${rest.opacity};${rest.weight ? `font-weight:${rest.weight};` : ''}`
  const box = el.ownerDocument.createElement('div')
  box.append(first, later)
  el.replaceChildren(box)
}

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
          let rest: string | undefined
          return {
            el,
            update(s) {
              const t = s.extra.text as string | undefined
              const r = s.extra.textRest as { size: number; weight: number; opacity: number } | undefined
              const restKey = r ? `${r.size}/${r.weight}/${r.opacity}` : undefined
              if (t !== text || restKey !== rest) {
                text = t
                rest = restKey
                renderText(el, t ?? '', r)
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
          // Fills show their color as a swatch, so solids and shapes are recognisable at a glance.
          const fill = clip.properties.find((p) => p.type === 'fill' && p.enabled)?.params.color?.value
          d.replaceChildren()
          if (typeof fill === 'string') {
            const swatch = document.createElement('span')
            swatch.style.cssText = `display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px;border-radius:3px;background:${fill};box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)`
            d.append(swatch, fill.toUpperCase())
          }
          if (typeof text === 'string') d.append(text)
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
        properties: [{ type: 'transform' }, { type: 'size', values: { size: [0.3 * (project.settings.height / project.settings.width), 0.3] } }, { type: 'fill', values: { color: '#e6e6ea' } }, { type: 'corners' }]
      })
    })
  }
})
