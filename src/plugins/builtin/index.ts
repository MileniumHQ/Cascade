import type { PluginDefinition } from '@core/plugin-api'
import { exportersPlugin } from './exporters'
import { exportPresetsPlugin } from './export-presets'
import { paramsPlugin } from './params'
import { easingsPlugin } from './easings'
import { settingsPlugin } from './settings'
import { commandsPlugin } from './commands'
import { editingPlugin } from './editing'
import { videoPlugin } from './media/video'
import { imagePlugin } from './media/image'
import { elementPlugin } from './media/element'
import { audioPlugin } from './media/audio'
import { visualPropertiesPlugin } from './properties/visual'
import { effectsPlugin } from './properties/effects'
import { textPropertiesPlugin } from './properties/text'
import { audioPropertiesPlugin } from './properties/audio'
import { timePropertiesPlugin } from './properties/time'
import { timelinePlugin } from './panels/timeline'
import { mcpPlugin } from './mcp'
import { previewPlugin } from './panels/preview'
import { sourcePlugin } from './panels/source'
import { inspectorPlugin } from './panels/inspector'
import { sourcesPlugin } from './panels/sources'
import { agentPanelPlugin } from './panels/agent'
import { statusBarPlugin } from './statusbar'
import { keyframesPlugin } from './panels/keyframes'
import { exportPanelPlugin } from './panels/export'
import { captionsPlugin } from './captions'
import { titlesPlugin } from './titles'
import { safetyPlugin } from './safety'
import { mixerPlugin } from './panels/mixer'
import { audioToolsPlugin } from './audio-tools'
import { colorPlugin } from './color'
import { transitionsPlugin } from './transitions'

/**
 * Everything Cascade can do comes from these plugins. They load first (built-in priority)
 * and are hidden from the plugin list; their settings live in global Settings.
 */
export const builtinPlugins: PluginDefinition[] = [
  exportersPlugin,
  exportPresetsPlugin,
  paramsPlugin,
  easingsPlugin,
  settingsPlugin,
  commandsPlugin,
  editingPlugin,
  videoPlugin,
  imagePlugin,
  elementPlugin,
  audioPlugin,
  visualPropertiesPlugin,
  effectsPlugin,
  colorPlugin,
  textPropertiesPlugin,
  audioPropertiesPlugin,
  timePropertiesPlugin,
  transitionsPlugin,
  previewPlugin,
  sourcePlugin,
  timelinePlugin,
  inspectorPlugin,
  sourcesPlugin,
  agentPanelPlugin,
  statusBarPlugin,
  mcpPlugin,
  keyframesPlugin,
  exportPanelPlugin,
  captionsPlugin,
  titlesPlugin,
  safetyPlugin,
  mixerPlugin,
  audioToolsPlugin
]

/** Plugins that are safe to load in headless export workers (no UI). */
export const renderPlugins: PluginDefinition[] = [exportersPlugin, paramsPlugin, easingsPlugin, videoPlugin, imagePlugin, elementPlugin, audioPlugin, visualPropertiesPlugin, effectsPlugin, colorPlugin, textPropertiesPlugin, audioPropertiesPlugin, timePropertiesPlugin, transitionsPlugin]
