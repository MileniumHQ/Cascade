import { definePlugin } from '@core/plugin-api'

const n = (v: unknown) => Number(v) || 0

/** Time properties: keyframeable playback speed (a time remap the stage integrates). */
export const timePropertiesPlugin = definePlugin({
  id: 'cascade.properties.time',
  name: 'Time properties',
  activate(ctx) {
    const timeBased = (clip: { type: string }) => !!ctx.app.registries.mediaTypes.get(clip.type)?.timeBased
    ctx.properties.register({
      id: 'speed',
      name: 'Speed',
      description: 'Playback speed; keyframe it for speed ramps',
      icon: 'gauge',
      category: 'Time',
      keywords: ['time', 'slow motion', 'fast forward', 'ramp', 'retime', 'rate'],
      appliesTo: timeBased,
      params: [{ id: 'speed', label: 'Speed', type: 'number', unit: 'x', default: 1, min: 0.05, max: 16, softMin: 0.25, softMax: 4, step: 0.05 }],
      timeRemap: 'speed',
      summary: (v) => `${+n(v.speed).toFixed(2)}×`
    })
  }
})
