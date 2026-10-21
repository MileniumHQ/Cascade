import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { PluginHost } from '@core/plugin-host'
import type { SettingContribution } from '@core/plugin-api'
import { Button, Empty, Modal, NumberField, Select, TextField, Toggle } from '../ui/kit'
import { Icon } from '../ui/icon'
import { useEmitter, useRegistry, useValue } from '../ui/reactive'
import { McpSetupBlock } from './McpSetup'

/**
 * Global settings. Built-in plugin settings live here as ordinary sections; only
 * external (user) plugins are listed under "Plugins" — built-ins are never marketed as plugins.
 */
export function SettingsModal(props: { app: CascadeApp; onClose: () => void }) {
  const { app } = props
  const settings = useRegistry(app.registries.settings)
  const values = useValue(app.settings.values)
  const host = app.services.get('plugins') as PluginHost | undefined
  const plugins = useEmitter(host?.onChange as never, () => (host?.list() ?? []).filter((p) => !p.builtin))

  const sections = createMemo(() => {
    const map = new Map<string, SettingContribution[]>()
    for (const s of settings()) {
      const list = map.get(s.section) ?? []
      list.push(s)
      map.set(s.section, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
  const [section, setSection] = createSignal<string>(sections()[0]?.[0] ?? 'Plugins')
  const get = (s: SettingContribution) => (values()[s.id] ?? s.default) as never

  return (
    <Modal title="Settings" icon="settings" onClose={props.onClose} width={760}>
      <div class="settings">
        <nav class="settings-nav">
          <For each={sections()}>
            {([name]) => (
              <button class={section() === name ? 'on' : ''} onClick={() => setSection(name)}>
                {name}
              </button>
            )}
          </For>
          <div class="settings-nav-sep" />
          <button class={section() === 'Plugins' ? 'on' : ''} onClick={() => setSection('Plugins')}>
            <Icon name="puzzle" size={13} /> Plugins
          </button>
        </nav>
        <div class="settings-body">
          <Show
            when={section() !== 'Plugins'}
            fallback={
              <div class="settings-plugins">
                <div class="settings-plugins-head">
                  <p class="hint">
                    Drop a <code>.js</code>/<code>.ts</code> plugin into the plugins folder — it loads instantly and hot-reloads when the file changes.
                  </p>
                  <Button icon="folder-open" size="sm" onClick={() => app.host!.plugins.openFolder()}>
                    Open folder
                  </Button>
                </div>
                <Show when={plugins().length} fallback={<Empty icon="puzzle" title="No plugins installed" hint="Agents can write plugins through the MCP server, too." />}>
                  <For each={plugins()}>
                    {(p) => (
                      <div class={`plugin-row ${p.error ? 'error' : ''}`}>
                        <Icon name={p.error ? 'triangle-alert' : 'puzzle'} size={15} />
                        <div class="plugin-meta">
                          <b>{p.def.name}</b>
                          <span>{p.error ?? p.def.description ?? p.def.id}</span>
                        </div>
                        <span class="plugin-ver tnum">{p.def.version ?? ''}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            }
          >
            <For each={sections().find(([n]) => n === section())?.[1] ?? []}>
              {(s) => (
                <div class="setting">
                  <div class="setting-text">
                    <b>{s.label}</b>
                    <Show when={s.description}>
                      <span>{s.description}</span>
                    </Show>
                  </div>
                  <div class="setting-input">
                    <Switch>
                      <Match when={s.type === 'toggle'}>
                        <Toggle value={!!get(s)} onChange={(v) => app.settings.set(s.id, v)} />
                      </Match>
                      <Match when={s.type === 'number'}>
                        <NumberField value={Number(get(s))} onChange={(v, phase) => phase !== 'update' && app.settings.set(s.id, v)} width="90px" />
                      </Match>
                      <Match when={s.type === 'select'}>
                        <Select value={String(get(s))} options={s.options ?? []} onChange={(v) => app.settings.set(s.id, v)} />
                      </Match>
                      <Match when={s.type === 'text'}>
                        <TextField value={String(get(s) ?? '')} onChange={(v) => app.settings.set(s.id, v)} />
                      </Match>
                    </Switch>
                  </div>
                </div>
              )}
            </For>
            <Show when={section() === 'Agents (MCP)'}>
              <McpSetupBlock app={app} />
            </Show>
          </Show>
        </div>
      </div>
    </Modal>
  )
}
