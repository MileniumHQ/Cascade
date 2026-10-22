import { definePlugin } from '@core/plugin-api'
import type { Disposable } from '@core/disposable'
import { solidMount } from '../../solid'
import { AgentActions, AgentPanel } from './Agent'
import './agent.css'

const DISABLED = 'agents.disabled'

export const agentPanelPlugin = definePlugin({
  id: 'cascade.panels.agent',
  name: 'Agent panel',
  activate(ctx) {
    ctx.settings.register({ id: DISABLED, section: 'Agents (MCP)', label: 'Disable Agents', description: 'Remove the Agent panel from the sidebar. The MCP server has its own toggle.', type: 'toggle', default: false })
    // The panel exists only while agents are enabled; with one side panel left the sidebar drops its switcher.
    let panel: Disposable | null = null
    const sync = () => {
      const disabled = ctx.app.settings.get<boolean>(DISABLED) === true
      if (disabled && panel) { panel.dispose(); panel = null }
      if (!disabled && !panel) panel = ctx.panels.register({
        id: 'agent',
        title: 'Agent',
        icon: 'sparkles',
        region: 'side',
        order: 20,
        mount: solidMount(AgentPanel),
        actions: solidMount(AgentActions)
      })
    }
    sync()
    ctx.track(ctx.app.settings.values.subscribe(sync))
    ctx.track({ dispose: () => { panel?.dispose(); panel = null } })
  }
})
