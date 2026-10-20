import { definePlugin } from '@core/plugin-api'
import { solidMount } from '../../solid'
import { AgentActions, AgentPanel } from './Agent'
import './agent.css'

export const agentPanelPlugin = definePlugin({
  id: 'cascade.panels.agent',
  name: 'Agent panel',
  activate(ctx) {
    ctx.panels.register({
      id: 'agent',
      title: 'Agent',
      icon: 'sparkles',
      region: 'side',
      order: 20,
      mount: solidMount(AgentPanel),
      actions: solidMount(AgentActions)
    })
  }
})
