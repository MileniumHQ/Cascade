import type { PropertyContribution } from '@core/plugin-api'
import { bakeCurves, coerceCurves, curveKey, defaultCurves } from '@shared/curve'
export const curvesProperty: PropertyContribution = {
  id: 'curves', name: 'Curves', description: 'Master and RGB tone curves', icon: 'sliders-horizontal', category: 'Color', cost: 'medium', stackable: true,
  params: [{ id: 'curve', label: 'Curves', type: 'curve', default: defaultCurves() }],
  shader: {
    fragment: `uniform sampler2D u_curves;
      float lookup(float x, int channel) {
        // Texel centers map exactly to [0,1], avoiding endpoint compression.
        vec4 v = texture(u_curves, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5));
        return v[channel];
      }
      vec4 effect(vec2 uv) {
        vec4 c = src(uv); vec3 rgb = straight(c);
        return vec4(vec3(lookup(rgb.r, 0), lookup(rgb.g, 1), lookup(rgb.b, 2)) * c.a, c.a);
      }`,
    textures(values, ctx) {
      const v = coerceCurves(values.curve), key = curveKey(v)
      return { u_curves: ctx.loadTexture(key, async () => ({ key, width: 256, height: 1, data: bakeCurves(v) })) }
    }
  }
}
