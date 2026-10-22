import { definePlugin } from '@core/plugin-api'
import { MASTER_CHANNEL } from '@shared/audio-mix'
import { solidMount } from '../../solid'
import { MeterBar } from './MeterBar'
import { MixerPanel } from './MixerPanel'

/** Compact master meter at the right of the status bar. */
const MasterMeter = (props: { ctx: { app: import('@core/app').CascadeAPI } }) => (
  <span class="status-item mx-status" data-tip="Master level">
    <MeterBar app={props.ctx.app} channel={MASTER_CHANNEL} orientation="horizontal" clip={false} />
  </span>
)

/** Per-track faders, pan, mute/solo and level meters, plus the master meter. */
export const mixerPlugin = definePlugin({
  id: 'cascade.panel.mixer',
  name: 'Mixer',
  activate(ctx) {
    ctx.panels.register({ id: 'mixer', title: 'Mixer', icon: 'sliders-vertical', region: 'bottom', order: 3, mount: solidMount(MixerPanel) })
    ctx.statusItems.register({ id: 'master-meter', align: 'right', order: 5, mount: solidMount(MasterMeter) })
    ctx.commands.register({ id: 'mixer.open', title: 'Show mixer', category: 'View', icon: 'sliders-vertical', run: (app) => app.layout.activeBottom.set('mixer') })
    ctx.menus.register({ id: 'menu:mixer.open', location: 'app/view', group: 'panels', command: 'mixer.open', label: 'Mixer', order: 30 })
  }
})
