import '../ui/theme.css'
import './app.css'
import { render } from 'solid-js/web'
import { CascadeApp } from '@core/app'
import { PluginHost, importPluginModule } from '@core/plugin-host'
import { builtinPlugins } from '@plugins/builtin'
import { pushToast } from '../ui/kit'
import { createSession } from './session'
import { App } from './App'

async function boot() {
  const host = window.cascade
  const app = new CascadeApp('editor', host)
  const plugins = new PluginHost(app)
  app.services.set('plugins', plugins)
  ;(window as unknown as { cascadeApp: CascadeApp }).cascadeApp = app // devtools & tests

  app.onNotify.on((n) => pushToast(n))
  plugins.onError.on(({ plugin, error }) => pushToast({ id: Date.now(), kind: 'error', message: `Plugin "${plugin}" failed`, detail: error.split('\n')[0] }))

  try {
    app.settings.values.set(await host.settings.load())
  } catch {}

  // Built-ins: the startup screen is literally Cascade loading itself.
  await plugins.activateAll(
    builtinPlugins.map((def) => ({ def, builtin: true })),
    async ({ plugin, done, total }) => {
      host.splash.progress(plugin ? `Loading ${plugin}` : 'Finishing things up…', done, total + 1)
    }
  )

  // External plugins (hot reloadable).
  const loaded = new Map<string, string>()
  const syncUserPlugins = async (files: Awaited<ReturnType<typeof host.plugins.list>>) => {
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.name)
      if (f.error) {
        pushToast({ id: Date.now(), kind: 'error', message: `Plugin ${f.name} has errors`, detail: f.error })
        continue
      }
      if (loaded.get(f.name) === f.url) continue
      try {
        const def = await importPluginModule(f.url)
        const prev = [...plugins.plugins.values()].find((p) => p.source === f.name)
        if (prev && prev.def.id !== def.id) plugins.deactivate(prev.def.id)
        await plugins.reload(def, f.name)
        if (loaded.has(f.name)) pushToast({ id: Date.now(), kind: 'success', message: `Reloaded ${def.name}` })
        loaded.set(f.name, f.url)
      } catch (e) {
        pushToast({ id: Date.now(), kind: 'error', message: `Plugin ${f.name} failed to load`, detail: String(e) })
      }
    }
    for (const [name] of loaded) {
      if (seen.has(name)) continue
      const p = [...plugins.plugins.values()].find((x) => x.source === name)
      if (p) plugins.deactivate(p.def.id)
      loaded.delete(name)
    }
  }
  try {
    host.splash.progress('Loading your plugins', 1, 1)
    await syncUserPlugins(await host.plugins.list())
    host.plugins.onChange((files) => void syncUserPlugins(files))
  } catch (e) {
    console.error(e)
  }

  const session = createSession(app)
  app.services.set('session', session)
  render(() => <App app={app} session={session} />, document.getElementById('root')!)
  requestAnimationFrame(() => host.splash.ready())
}

boot().catch((e) => {
  console.error(e)
  document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">Cascade failed to start\n\n${e?.stack ?? e}</pre>`
  window.cascade?.splash.ready()
})
