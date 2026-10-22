import type { CascadeAPI } from '@core/app'
import { unitHelpers } from '@ui/param-units'
import { evaluateProperty, isAnimated, keyframeAt } from '@core/evaluate'
import type { Cleanup, ParamDef, ParamEditorContext, PropertyContribution, PropertyEditorContext } from '@core/plugin-api'
import { findClip, type Clip, type Id, type ParamValue, type PropertyInstance } from '@shared/project'

export const clipOf = (app: CascadeAPI, clipId: Id): Clip | undefined => findClip(app.timeline(), clipId)?.clip

export const instanceOf = (app: CascadeAPI, clipId: Id, propId: Id): PropertyInstance | undefined =>
  clipOf(app, clipId)?.properties.find((p) => p.id === propId)

export const paramValueOf = (app: CascadeAPI, clipId: Id, propId: Id, paramId: string): ParamValue | undefined =>
  instanceOf(app, clipId, propId)?.params[paramId]

/**
 * Fires on every document change, and on playhead moves while `animated()` is true
 * (a static value can't change with time, so ticking would only waste work).
 */
export function subscribeEditing(app: CascadeAPI, fn: () => void, animated: () => boolean): Cleanup {
  const a = app.doc.onChange.on(fn)
  const b = app.playback.time.subscribe(() => {
    if (animated()) fn()
  })
  return () => {
    a.dispose()
    b.dispose()
  }
}

// ───────────────────────────── editor contexts ─────────────────────────────

export function makeParamContext(app: CascadeAPI, clipId: Id, propId: Id, def: ParamDef): ParamEditorContext {
  const units = unitHelpers(app, def.unit)
  const pv = () => paramValueOf(app, clipId, propId, def.id)
  return {
    app,
    def,
    get: () => app.edit.paramValue(clipId, propId, def.id),
    set: (value, opts) => app.edit.setParam(clipId, propId, def.id, value, { gesture: opts?.gesture }),
    subscribe: (fn) => subscribeEditing(app, fn, () => isAnimated(pv())),
    ...units,
    get animated() {
      return isAnimated(pv())
    },
    // unclamped: a playhead outside the clip is never "on" a keyframe
    keyed: () => {
      const clip = clipOf(app, clipId)
      return !!clip && !!keyframeAt(pv(), app.playback.time.get() - clip.start)
    }
  }
}

export function makePropertyContext(app: CascadeAPI, clipId: Id, propId: Id, contrib: PropertyContribution): PropertyEditorContext {
  const anyAnimated = () => Object.values(instanceOf(app, clipId, propId)?.params ?? {}).some(isAnimated)
  return {
    app,
    clipId,
    propertyId: propId,
    values() {
      const inst = instanceOf(app, clipId, propId)
      return inst ? evaluateProperty(app.registries, contrib, inst, app.edit.localTime(clipId)) : {}
    },
    set: (paramId, value, opts) => app.edit.setParam(clipId, propId, paramId, value, { gesture: opts?.gesture }),
    subscribe: (fn) => subscribeEditing(app, fn, anyAnimated)
  }
}

export { unitHelpers, UNIT_LABELS } from '@ui/param-units'
