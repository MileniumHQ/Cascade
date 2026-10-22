/** Drop into Settings → Plugins → Open folder. This file needs no runtime imports. */
import type { PluginDefinition } from '../../src/core/plugin-api'

const plugin: PluginDefinition = {
  id: 'example.posterize', name: 'Posterize',
  activate(ctx) {
    ctx.properties.register({
      id: 'example.posterize', name: 'Posterize', description: 'Reduce RGB channel levels',
      icon: 'palette', category: 'Stylize', cost: 'cheap', stackable: true,
      params: [{ id: 'levels', label: 'Levels', type: 'number', default: 6, min: 2, max: 64, step: 1 }],
      shader: {
        fragment: `
          uniform float u_levels;
          vec4 effect(vec2 uv) {
            vec4 c = src(uv);
            vec3 rgb = floor(straight(c) * (u_levels - 1.0) + 0.5) / (u_levels - 1.0);
            return vec4(rgb * c.a, c.a);
          }
        `,
        uniforms: values => ({ u_levels: Number(values.levels) })
      }
    })
  }
}
export default plugin
