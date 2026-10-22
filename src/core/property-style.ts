import { uid, type Keyframe, type ParamValue, type PropertyInstance } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { GeneratedProperty } from './plugin-api'

/**
 * A look expressed as parameter values per property type. `null` removes that property type.
 * Used by presets (caption styles…) to restyle clips that already exist.
 */
export type PropertyStyle = Record<string, Record<string, unknown> | null>

/**
 * Apply a style to a clip's property list in place: the first instance of each type gets the values
 * (animation on those params is dropped), missing types are created through `make`, `null` removes the type.
 * Returns whether anything changed.
 */
export function applyPropertyStyle(
  properties: PropertyInstance[],
  style: PropertyStyle,
  make: (type: string, values: Record<string, unknown>) => PropertyInstance | null
): boolean {
  let changed = false
  for (const [type, values] of Object.entries(style)) {
    if (values === null) {
      const kept = properties.filter((p) => p.type !== type)
      if (kept.length !== properties.length) {
        properties.splice(0, properties.length, ...kept)
        changed = true
      }
      continue
    }
    const existing = properties.find((p) => p.type === type)
    if (existing) {
      for (const [id, value] of Object.entries(values)) existing.params[id] = { value }
      changed = changed || Object.keys(values).length > 0
    } else {
      const created = make(type, values)
      if (created) {
        properties.push(created)
        changed = true
      }
    }
  }
  return changed
}

/** Resolve a generator's keyframe description against the clip's duration. */
export function generatedKeyframes(spec: NonNullable<GeneratedProperty['keyframes']>, duration: Flicks, defaultEasing: string): Record<string, Keyframe[]> {
  const out: Record<string, Keyframe[]> = {}
  for (const [param, list] of Object.entries(spec)) {
    const frames = list
      .map((k): Keyframe => ({ id: uid('kf_'), t: Math.round(Math.max(0, Math.min(duration, k.fromEnd ? duration - k.t : k.t))), value: structuredClone(k.value), easing: { id: k.easing ?? defaultEasing } }))
      .sort((a, b) => a.t - b.t)
    if (frames.length) out[param] = frames
  }
  return out
}

/** Attach resolved keyframes to a property instance (the static value becomes the first keyframe's). */
export function withKeyframes(inst: PropertyInstance, frames: Record<string, Keyframe[]>): PropertyInstance {
  for (const [param, kfs] of Object.entries(frames)) {
    const pv: ParamValue = inst.params[param] ?? { value: kfs[0].value }
    inst.params[param] = { ...pv, value: kfs[0].value, keyframes: kfs }
  }
  return inst
}
