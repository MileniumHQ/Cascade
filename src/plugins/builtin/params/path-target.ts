import type { CascadeAPI } from '@core/app'
import { findClip } from '@shared/project'
import { coercePath } from '@shared/path'

/** Overlay id that param types declare in `directEdit` to be edited by the path handles. */
export const PATH_EDITOR_OVERLAY = 'path-editor'

/** The path param of the selected property the path overlay edits: found through `ParamTypeContribution.directEdit`, preferring `selection.param`. */
export function selectedPath(app: CascadeAPI) {
  const clipId = app.selection.primaryClip, propertyId = app.selection.property.get()
  if (!clipId || !propertyId) return null
  const found = findClip(app.timeline(), clipId)
  if (!found || found.track.locked || found.track.kind !== 'visual') return null
  const property = found.clip.properties.find(p => p.id === propertyId)
  if (!property?.enabled) return null
  const defs = app.registries.properties.get(property.type)?.params.filter(p => app.registries.paramTypes.get(p.type)?.directEdit === PATH_EDITOR_OVERLAY) ?? []
  const def = defs.find(p => p.id === app.selection.param.get()) ?? defs[0]
  return def ? { clipId, propertyId, paramId: def.id, value: coercePath(app.edit.paramValue(clipId, propertyId, def.id)) } : null
}
