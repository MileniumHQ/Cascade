import { CascadeApp, type CascadeAPI } from '@core/app'

/**
 * Run several edits as ONE undo step: they are applied to a scratch copy of the project and the
 * result is committed as a single transaction. Returns what `fn` returned.
 */
export async function inOneStep<T>(app: CascadeAPI, label: string, fn: (scratch: CascadeApp) => Promise<T> | T): Promise<T> {
  const scratch = new CascadeApp('editor', null, structuredClone(app.project()))
  Object.assign(scratch.registries, app.registries)
  scratch.settings.values.set(app.settings.values.get())
  const result = await fn(scratch)
  const next = scratch.project()
  app.doc.transact(label, (draft) => {
    Object.assign(draft, next)
  })
  return result
}
