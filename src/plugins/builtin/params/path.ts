import type { ParamTypeContribution } from '@core/plugin-api'
import { coercePath, ellipsePath, interpolatePath, rectanglePath, type PathValue } from '@shared/path'

export const pathParam: ParamTypeContribution<PathValue> = {
  id: 'path', interpolate: interpolatePath, directEdit: 'path-editor',
  coerce: (v, d) => coercePath(v, coercePath(d.default)),
  format: v => `${v.points.length} points`,
  // A path has variable topology; graph-editor numeric channels would be misleading.
  editor(el, ctx) {
    const row = document.createElement('div')
    row.className = 'path-param'
    const edit = document.createElement('button')
    edit.className = 'btn btn-default btn-sm'
    edit.title = 'Drag points or the shape on the preview. Drag handles; Alt breaks symmetry. Click an edge to insert, double-click a point to smooth. Delete removes a point; Escape deselects it.'
    edit.onclick = () => {
      ctx.app.selection.param.set(ctx.def.id)
      ctx.app.run('path.edit')
    }
    const button = (label: string, action: () => PathValue) => {
      const b = document.createElement('button'); b.className = 'btn btn-default btn-sm'; b.textContent = label
      b.onclick = () => ctx.set(action()); row.append(b)
    }
    row.append(edit)
    const presets = ctx.def.config?.presets
    if (presets) { button('Rectangle', () => rectanglePath()); button('Ellipse', () => ellipsePath()) }
    button('Reset', () => coercePath(ctx.def.default))
    el.append(row)
    const draw = () => { edit.textContent = `${coercePath(ctx.get()).points.length} points · Edit on preview` }
    const off = ctx.subscribe(draw); draw()
    return () => { off(); row.remove() }
  }
}
