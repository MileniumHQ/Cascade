import { definePlugin, type ExportPresetContribution } from '@core/plugin-api'

/** Ready-made Export panel settings. Plugins add their own with `ctx.exportPresets.register`. */
export const exportPresets: ExportPresetContribution[] = [
  { id: 'youtube-1080', name: 'YouTube 1080p (H.264)', description: '1920×1080, high quality H.264 with AAC', icon: 'film', exporter: 'mp4-h264', options: { quality: 18, preset: 'medium' }, size: { width: 1920, height: 1080 } },
  { id: 'youtube-4k', name: 'YouTube 4K (HEVC)', description: '3840×2160, HEVC with AAC', icon: 'film', exporter: 'mp4-hevc', options: { quality: 20, preset: 'medium' }, size: { width: 3840, height: 2160 } },
  { id: 'vertical-1080', name: 'Vertical 1080×1920 (H.264)', description: 'Shorts, Reels and TikTok', icon: 'smartphone', exporter: 'mp4-h264', options: { quality: 20, preset: 'medium' }, size: { width: 1080, height: 1920 } },
  { id: 'web-720', name: 'Web 720p (VP9)', description: '1280×720 WebM for embedding', icon: 'film', exporter: 'webm-vp9', options: { quality: 34 }, size: { width: 1280, height: 720 } },
  { id: 'prores-master', name: 'ProRes master', description: 'ProRes 422 HQ at the project size, for further editing', icon: 'film', exporter: 'mov-prores' },
  { id: 'gif-preview', name: 'GIF preview', description: '640×360 at 24 fps', icon: 'images', exporter: 'gif', size: { width: 640, height: 360 }, fps: { num: 24, den: 1 } },
  { id: 'audio-wav', name: 'Audio only (WAV)', description: 'Uncompressed stereo mixdown', icon: 'audio-lines', exporter: 'wav' },
  { id: 'audio-mp3', name: 'Audio only (MP3)', description: '192 kb/s stereo mixdown', icon: 'audio-lines', exporter: 'mp3', options: { audioBitrate: 192 } }
]

export const exportPresetsPlugin = definePlugin({
  id: 'cascade.exportPresets',
  name: 'Export presets',
  dependsOn: ['cascade.exporters'],
  activate(ctx) {
    exportPresets.forEach((preset, i) => ctx.exportPresets.register({ priority: 500 + i, ...preset }))
  }
})
