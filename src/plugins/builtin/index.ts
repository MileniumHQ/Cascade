import type { PluginDefinition } from '@core/plugin-api'
import { definePlugin } from '@core/plugin-api'
import { paramsPlugin } from './params'
import { easingsPlugin } from './easings'
import { settingsPlugin } from './settings'
import { commandsPlugin } from './commands'
import { videoPlugin } from './media/video'
import { imagePlugin } from './media/image'
import { elementPlugin } from './media/element'
import { audioPlugin } from './media/audio'
import { visualPropertiesPlugin } from './properties/visual'
import { effectsPlugin } from './properties/effects'
import { textPropertiesPlugin } from './properties/text'
import { audioPropertiesPlugin } from './properties/audio'
import { placeholderPanel } from './panels/placeholder'
import { timelinePlugin } from './panels/timeline'
import { previewPlugin } from './panels/preview'
import { inspectorPlugin } from './panels/inspector'

const panelsPlugin = definePlugin({
  id: 'cascade.panels',
  name: 'Panels',
  activate(ctx) {
    ctx.panels.register(placeholderPanel({ id: 'sources', title: 'Sources', icon: 'folder-open', region: 'side' }))
    ctx.panels.register(placeholderPanel({ id: 'keyframes', title: 'Keyframes', icon: 'diamond', region: 'bottom', order: 1 }))
    ctx.panels.register(placeholderPanel({ id: 'export', title: 'Export', icon: 'clapperboard', region: 'bottom', order: 2 }))
  }
})

/**
 * Everything Cascade can do comes from these plugins. They load first (built-in priority)
 * and are hidden from the plugin list; their settings live in global Settings.
 */
export const builtinPlugins: PluginDefinition[] = [
  paramsPlugin,
  easingsPlugin,
  settingsPlugin,
  commandsPlugin,
  videoPlugin,
  imagePlugin,
  elementPlugin,
  audioPlugin,
  visualPropertiesPlugin,
  effectsPlugin,
  textPropertiesPlugin,
  audioPropertiesPlugin,
  panelsPlugin,
  previewPlugin,
  timelinePlugin,
  inspectorPlugin
]

/** Plugins that are safe to load in headless export workers (no UI). */
export const renderPlugins: PluginDefinition[] = [paramsPlugin, easingsPlugin, videoPlugin, imagePlugin, elementPlugin, audioPlugin, visualPropertiesPlugin, effectsPlugin, textPropertiesPlugin, audioPropertiesPlugin]
