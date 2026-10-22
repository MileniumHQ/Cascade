import type { CascadeAPI } from '@core/app'
import { findClip } from '@shared/project'
import { coercePath } from '@shared/path'
import { PATH_PARAM_SERVICE } from '../../params/path'

/** Any selected enabled property may expose one or several path parameters. */
export function selectedPath(app: CascadeAPI) {
  const clipId = app.selection.primaryClip, propertyId = app.selection.property.get()
  if (!clipId || !propertyId) return null
  const found = findClip(app.timeline(), clipId)
  if (!found || found.track.locked || found.track.kind !== 'visual') return null
  const property = found.clip.properties.find(p => p.id === propertyId)
  if (!property?.enabled) return null
  const defs = app.registries.properties.get(property.type)?.params.filter(p => p.type === 'path') ?? []
  const def = defs.find(p => p.id === app.services.get(PATH_PARAM_SERVICE)) ?? defs[0]
  return def ? { clipId, propertyId, paramId: def.id, value: coercePath(app.edit.paramValue(clipId, propertyId, def.id)) } : null
}
