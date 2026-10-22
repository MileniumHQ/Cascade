/**
 * Example Cascade plugin: more presets for built-in features.
 *
 *  - an export preset (appears in the Export panel's Preset list, hidden if its exporter is missing),
 *  - a caption style (appears in "Caption style…" and "Restyle selected captions…"),
 *  - a title template (a generator in the Sources "Create" list, under its category).
 *
 * Keyboard shortcuts need no plugin code: contribute a keybinding for your command and users can
 * rebind it in Settings → Keyboard.
 */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.presets',
  name: 'Example presets',
  activate(ctx) {
    ctx.exportPresets.register({
      id: 'example.instagram-square',
      name: 'Square 1080 (H.264)',
      description: 'Feed posts',
      icon: 'square',
      exporter: 'mp4-h264',
      options: { quality: 20 },
      size: { width: 1080, height: 1080 }
    })

    // Caption styles are presets of kind "captions.style": parameter values per property type.
    // `null` drops a property type the caption would otherwise have.
    ctx.presets.register({
      id: 'captions.style:example-neon',
      kind: 'captions.style',
      name: 'Neon',
      icon: 'captions',
      value: { text: { color: '#7dffb2', weight: 800, stroke: 0 }, shadow: { offset: [0, 0], blur: 0.02, color: '#7dffb2cc' } }
    })

    // A title template is an ordinary generator: element clip + properties (+ keyframes).
    ctx.generators.register({
      id: 'example.title.badge',
      name: 'Badge',
      description: 'Small rounded label that fades in',
      icon: 'title',
      mediaType: 'element',
      category: 'Titles',
      create: () => ({
        name: 'Badge',
        clipData: { kind: 'title' },
        properties: [
          { type: 'transform', values: { position: [-0.38, -0.4] } },
          { type: 'opacity', keyframes: { opacity: [{ t: 0, value: 0 }, { t: 705_600_000 * 0.4, value: 1 }] } },
          { type: 'size', values: { size: [0.2, 0.07], padding: 0.01 } },
          { type: 'fill', values: { color: '#ff4d6d' } },
          { type: 'corners', values: { radius: 0.035 } },
          { type: 'text', values: { text: 'NEW', size: 0.035, weight: 800 } }
        ]
      })
    })
  }
}

export default plugin
