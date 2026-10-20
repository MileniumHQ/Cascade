/**
 * Example Cascade plugin: a procedural "Wiggle" (handheld camera shake) property.
 *
 * Drop this file into your plugins folder (Settings → Plugins → Open folder). Cascade compiles
 * it with esbuild and hot-reloads it every time you save: edit `amount`'s default below, save,
 * and the preview updates without restarting.
 *
 * Plugins export a plain definition object. The type import is erased at build time, so it's
 * only there for editor autocompletion when you work inside the Cascade repo.
 */
import type { PluginDefinition } from '../../src/core/plugin-api'

// Smooth 1D value noise in [-1, 1]: deterministic per (seed, t), so export frames match preview.
const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}
const noise = (t: number, seed: number) => {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return hash(i + seed * 1000) * (1 - u) + hash(i + 1 + seed * 1000) * u
}

const FLICKS = 705_600_000

const plugin: PluginDefinition = {
  id: 'example.wiggle',
  name: 'Wiggle',
  activate(ctx) {
    ctx.properties.register({
      id: 'wiggle',
      name: 'Wiggle',
      description: 'Procedural handheld shake — no keyframes needed',
      icon: 'activity',
      category: 'Motion',
      keywords: ['shake', 'handheld', 'jitter', 'camera', 'noise'],
      params: [
        // Spatial values are fractions of the frame, never px — the stage converts them to cqw/cqh.
        { id: 'amount', label: 'Amount', type: 'number', unit: 'percent', default: 0.01, min: 0, max: 0.2, step: 0.1 },
        { id: 'rotation', label: 'Rotation', type: 'angle', default: 1, min: 0, max: 45 },
        { id: 'frequency', label: 'Frequency', type: 'number', default: 2, min: 0.1, max: 30, step: 0.1 },
        { id: 'seed', label: 'Seed', type: 'number', default: 1, min: 0, max: 999, step: 1 }
      ],
      apply(v, { u, local }) {
        const t = (local / FLICKS) * Number(v.frequency)
        const seed = Number(v.seed)
        const a = Number(v.amount)
        return {
          transform: [
            `translate(${u.x(noise(t, seed) * a)}, ${u.y(noise(t, seed + 0.5) * a)})`,
            `rotate(${noise(t, seed + 0.25) * Number(v.rotation)}deg)`
          ]
        }
      },
      summary: (v) => `${Math.round(Number(v.amount) * 1000) / 10}% @ ${v.frequency} Hz`
    })
  }
}

export default plugin
