import { createResource, createSignal, Show } from 'solid-js'
import type { CascadeApp } from '@core/app'
import { Button, Segmented, Select } from '../ui/kit'
import { MCP_CLIENTS, mcpSetup, type McpClient, type McpScope, type McpTransport } from './mcp-setup'

/** Settings → Agents (MCP): ready-to-paste client configurations for this editor's MCP server. */
export function McpSetupBlock(props: { app: CascadeApp }) {
  const [info] = createResource(() => props.app.host?.info())
  const [client, setClient] = createSignal<McpClient>('claude')
  const [scope, setScope] = createSignal<McpScope>('project')
  const [transport, setTransport] = createSignal<McpTransport>('http')
  const [copied, setCopied] = createSignal(false)
  const setup = () => {
    const i = info()
    return i?.mcp.url ? mcpSetup(client(), scope(), transport(), { ...i.mcp, platform: i.platform }) : null
  }
  const copy = async () => {
    await navigator.clipboard.writeText(setup()!.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div class="mcp-setup">
      <div class="setting-text">
        <b>Connect an agent</b>
        <span>Paste this into your agent’s configuration. Cascade must be running for the agent to reach it.</span>
      </div>
      <Show when={setup()} fallback={<p class="hint">The MCP server isn’t running.</p>}>
        {(s) => (
          <>
            <div class="mcp-setup-controls">
              <Segmented value={client()} options={MCP_CLIENTS} onChange={setClient} />
            </div>
            <div class="mcp-setup-controls">
              <Select
                value={scope()}
                width="130px"
                options={[
                  { value: 'project', label: 'In project' },
                  { value: 'global', label: 'Global' }
                ]}
                onChange={setScope}
              />
              <Select
                value={transport()}
                width="110px"
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'stdio', label: 'stdio' }
                ]}
                onChange={setTransport}
              />
              <span class="mcp-setup-target">{s().target}</span>
            </div>
            <div class="mcp-setup-code">
              <pre>{s().text}</pre>
              <Button size="sm" icon={copied() ? 'check' : 'copy'} onClick={copy}>
                {copied() ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p class="hint">
              {transport() === 'http'
                ? 'Contains your access token; keep it private' + (scope() === 'project' ? ' and out of version control.' : '.') + ' If port 47823 is taken at startup Cascade picks another; stdio avoids that.'
                : 'Runs a small proxy from this Cascade install that connects to the open editor.'}
              <Show when={s().note}> {s().note}</Show>
            </p>
          </>
        )}
      </Show>
    </div>
  )
}
