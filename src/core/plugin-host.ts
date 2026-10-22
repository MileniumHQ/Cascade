import type { CascadeApp, Registries } from './app'
import { DisposableStore, type Disposable } from './disposable'
import type { PluginContext, PluginDefinition, Registrar } from './plugin-api'
import { Emitter } from './events'

/** Registries that only make sense with a UI; in the render env, registering is a no-op. */
const EDITOR_ONLY: (keyof Registries)[] = ['panels', 'overlays', 'keybindings', 'menus', 'statusItems']

export interface LoadedPlugin {
  def: PluginDefinition
  builtin: boolean
  source?: string
  store: DisposableStore
  error?: string
  active: boolean
}

export interface ActivationProgress {
  plugin: string
  done: number
  total: number
}

export class PluginHost {
  readonly plugins = new Map<string, LoadedPlugin>()
  readonly onChange = new Emitter<void>()
  readonly onError = new Emitter<{ plugin: string; error: string }>()

  constructor(private app: CascadeApp) {}

  private context(def: PluginDefinition, builtin: boolean, store: DisposableStore): PluginContext {
    const app = this.app
    const regs = app.registries
    const reg = <K extends keyof Registries>(key: K): Registrar<any> => ({
      register(value: any): Disposable {
        if (app.env === 'render' && EDITOR_ONLY.includes(key)) return { dispose() {} }
        if (!builtin && value.priority !== undefined && value.priority < 1000) value = { ...value, priority: 1000 + value.priority }
        if (value.priority === undefined && def.priority !== undefined) value = { ...value, priority: def.priority }
        return store.add(regs[key].register(value, def.id, builtin))
      }
    })
    return {
      plugin: { id: def.id, name: def.name, builtin },
      env: app.env,
      app,
      mediaTypes: reg('mediaTypes'),
      transitions: reg('transitions'),
      properties: reg('properties'),
      paramTypes: reg('paramTypes'),
      easings: reg('easings'),
      panels: reg('panels'),
      overlays: reg('overlays'),
      commands: reg('commands'),
      keybindings: reg('keybindings'),
      menus: reg('menus'),
      statusItems: reg('statusItems'),
      settings: reg('settings'),
      exporters: reg('exporters'),
      generators: reg('generators'),
      exportPresets: reg('exportPresets'),
      presets: reg('presets'),
      track: (d) => store.add(d),
      log: (...args) => console.log(`[${def.id}]`, ...args)
    }
  }

  /** Topologically sort by dependsOn, then priority. */
  private order(defs: { def: PluginDefinition; builtin: boolean }[]) {
    const byId = new Map(defs.map((d) => [d.def.id, d]))
    const sorted = [...defs].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      return (a.def.priority ?? 500) - (b.def.priority ?? 500)
    })
    const out: typeof defs = []
    const seen = new Set<string>()
    const visit = (d: (typeof defs)[number], stack: Set<string>) => {
      if (seen.has(d.def.id)) return
      if (stack.has(d.def.id)) throw new Error(`Plugin dependency cycle at ${d.def.id}`)
      stack.add(d.def.id)
      for (const dep of d.def.dependsOn ?? []) {
        const x = byId.get(dep)
        if (x) visit(x, stack)
      }
      stack.delete(d.def.id)
      seen.add(d.def.id)
      out.push(d)
    }
    for (const d of sorted) visit(d, new Set())
    return out
  }

  async activateAll(
    defs: { def: PluginDefinition; builtin: boolean; source?: string }[],
    onProgress?: (p: ActivationProgress) => void | Promise<void>
  ) {
    const ordered = this.order(defs)
    let done = 0
    for (const d of ordered) {
      await onProgress?.({ plugin: d.def.name, done, total: ordered.length })
      await this.activate(d.def, d.builtin, (d as { source?: string }).source)
      done++
    }
    await onProgress?.({ plugin: '', done, total: ordered.length })
  }

  async activate(def: PluginDefinition, builtin: boolean, source?: string): Promise<LoadedPlugin> {
    this.deactivate(def.id)
    const store = new DisposableStore()
    const loaded: LoadedPlugin = { def, builtin, source, store, active: false }
    this.plugins.set(def.id, loaded)
    try {
      await def.activate(this.context(def, builtin, store))
      loaded.active = true
    } catch (e) {
      loaded.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
      store.dispose()
      console.error(`[cascade] plugin ${def.id} failed to activate`, e)
      this.onError.emit({ plugin: def.id, error: loaded.error })
    }
    this.onChange.emit()
    return loaded
  }

  deactivate(id: string) {
    const p = this.plugins.get(id)
    if (!p) return
    try {
      p.def.deactivate?.()
    } catch (e) {
      console.error(e)
    }
    p.store.dispose()
    p.active = false
    this.plugins.delete(id)
    this.onChange.emit()
  }

  /** Swap in new code for a plugin (hot reload). All its contributions are replaced atomically-ish. */
  async reload(def: PluginDefinition, source?: string) {
    const prev = this.plugins.get(def.id)
    return this.activate(def, prev?.builtin ?? false, source)
  }

  list(includeBuiltins = false) {
    return [...this.plugins.values()].filter((p) => includeBuiltins || !p.builtin)
  }
}

/** Load external plugin modules from URLs (served by main with cache-busting for hot reload). */
export async function importPluginModule(url: string): Promise<PluginDefinition> {
  const mod = await import(/* @vite-ignore */ url)
  const def = (mod.default ?? mod.plugin ?? mod) as PluginDefinition
  if (!def || typeof def.activate !== 'function' || !def.id) throw new Error('Plugin module must export default { id, name, activate(ctx) }')
  return def
}
