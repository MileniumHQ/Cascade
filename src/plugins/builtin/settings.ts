import { definePlugin } from '@core/plugin-api'

/** Global settings that belong to built-in features (they show up as plain sections in Settings). */
export const settingsPlugin = definePlugin({
  id: 'cascade.settings',
  name: 'Settings',
  activate(ctx) {
    const s = ctx.settings
    s.register({
      id: 'keyframes.defaultEasing',
      section: 'Keyframes',
      label: 'Default easing',
      description: 'Easing given to new keyframes',
      type: 'select',
      default: 'ease-in-out',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'ease-in-out', label: 'Ease in-out' },
        { value: 'ease-out', label: 'Ease out' },
        { value: 'cubic-in-out', label: 'Cubic in-out' },
        { value: 'expo-out', label: 'Expo out' },
        { value: 'spring', label: 'Spring' },
        { value: 'hold', label: 'Hold' }
      ]
    })
    s.register({ id: 'preview.adaptive', section: 'Preview', label: 'Adaptive quality', description: 'Lower preview resolution while playing when frames drop', type: 'toggle', default: true })
    s.register({
      id: 'preview.resolution',
      section: 'Preview',
      label: 'Preview resolution',
      description: 'Upper bound for the preview render size',
      type: 'select',
      default: 'full',
      options: [
        { value: 'full', label: 'Full' },
        { value: 'half', label: 'Half' },
        { value: 'quarter', label: 'Quarter' }
      ]
    })
    s.register({ id: 'timeline.thumbnails', section: 'Timeline', label: 'Video thumbnails', description: 'Show film-strip thumbnails on video clips', type: 'toggle', default: true })
    s.register({ id: 'timeline.waveforms', section: 'Timeline', label: 'Audio waveforms', type: 'toggle', default: true })
    s.register({ id: 'timeline.followPlayhead', section: 'Timeline', label: 'Follow playhead', description: 'Scroll the timeline while playing', type: 'toggle', default: true })
    s.register({ id: 'export.workers', section: 'Export', label: 'Parallel render workers', description: '0 = automatic (based on CPU cores)', type: 'number', default: 0 })
    s.register({ id: 'export.hardware', section: 'Export', label: 'Hardware encoding', description: 'Use the GPU encoder (VAAPI/NVENC/VideoToolbox) when available', type: 'toggle', default: true })
    s.register({ id: 'mcp.enabled', section: 'Agents (MCP)', label: 'MCP server', description: 'Let AI agents edit projects through the local MCP server', type: 'toggle', default: true })
  }
})
