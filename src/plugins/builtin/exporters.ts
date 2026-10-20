import { definePlugin, type ExporterContribution, type ParamDef } from '@core/plugin-api'
import type { FFmpegExportPlan } from '@shared/ipc'

const quality: ParamDef = { id: 'quality', label: 'Quality (CRF)', type: 'number', default: 23, min: 0, max: 51, step: 1 }
const preset: ParamDef = { id: 'preset', label: 'Preset', type: 'select', default: 'veryfast', options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map(value => ({ value, label: value })) }
const hardware: ParamDef = { id: 'hardware', label: 'Hardware encoding', type: 'toggle', default: true }
const bitrate: ParamDef = { id: 'audioBitrate', label: 'Audio bitrate (kb/s)', type: 'number', default: 192, min: 32, max: 512, step: 16 }
const speed: ParamDef = { id: 'speed', label: 'Speed', type: 'number', default: 6, min: 0, max: 8, step: 1 }
const num = (o: Record<string, unknown>, key: string, d: number, lo: number, hi: number) => String(Math.max(lo, Math.min(hi, Number(o[key] ?? d) || d)))
const audio = (o: Record<string, unknown>, codec: string) => ['-c:a', codec, '-b:a', `${num(o, 'audioBitrate', 192, 32, 512)}k`]
const choosePreset = (o: Record<string, unknown>) => preset.options!.some(p => p.value === o.preset) ? String(o.preset) : 'veryfast'
const mp4 = (codec: 'h264' | 'hevc'): ExporterContribution => ({
  id: `mp4-${codec}`, name: `MP4 (${codec === 'h264' ? 'H.264' : 'HEVC'})`, extension: 'mp4',
  description: 'High quality MPEG-4 video with AAC audio', video: true, audio: true,
  options: [quality, preset, hardware, bitrate],
  ffmpeg(o, info) {
    const software = ['-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', choosePreset(o), '-crf', num(o, 'quality', 23, 0, 51), '-pix_fmt', 'yuv420p']
    if (codec === 'hevc') software.push('-tag:v', 'hvc1')
    const plan: FFmpegExportPlan = { videoArgs: software, audioArgs: info.hasAudio ? audio(o, 'aac') : [], extension: 'mp4', container: 'mp4', concatSafe: true }
    if (o.hardware !== false && info.hwEncoders.includes(`${codec}_vaapi`)) {
      plan.videoArgs = ['-vf', 'format=nv12,hwupload', '-c:v', `${codec}_vaapi`, '-qp', num(o, 'quality', 23, 0, 51), ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      plan.inputArgs = ['-vaapi_device', '/dev/dri/renderD128']
      plan.fallback = { videoArgs: software }
    }
    return plan
  }
})

export const exporters: ExporterContribution[] = [
  mp4('h264'), mp4('hevc'),
  {
    id: 'webm-vp9', name: 'WebM (VP9)', extension: 'webm', description: 'Open VP9 video with Opus audio', video: true, audio: true,
    options: [{ ...quality, default: 32, max: 63 }, speed, bitrate],
    ffmpeg: (o, i) => ({ videoArgs: ['-c:v', 'libvpx-vp9', '-crf', num(o, 'quality', 32, 0, 63), '-b:v', '0', '-deadline', 'realtime', '-cpu-used', num(o, 'speed', 6, 0, 8), '-row-mt', '1', '-pix_fmt', 'yuv420p'], audioArgs: i.hasAudio ? audio(o, 'libopus') : [], extension: 'webm', container: 'webm', concatSafe: true })
  },
  ...(['webm', 'mkv'] as const).map((ext): ExporterContribution => ({
    id: `${ext}-av1`, name: `${ext === 'webm' ? 'WebM' : 'MKV'} (AV1)`, extension: ext, description: 'Efficient AV1 video with Opus audio', video: true, audio: true,
    options: [{ ...quality, default: 32, max: 63 }, { ...speed, default: 8, max: 13 }, hardware, bitrate],
    ffmpeg(o, i) {
      const software = ['-c:v', 'libsvtav1', '-crf', num(o, 'quality', 32, 0, 63), '-preset', num(o, 'speed', 8, 0, 13), '-pix_fmt', 'yuv420p']
      const plan: FFmpegExportPlan = { videoArgs: software, audioArgs: i.hasAudio ? audio(o, 'libopus') : [], extension: ext, container: ext === 'mkv' ? 'matroska' : 'webm', concatSafe: true }
      if (o.hardware !== false && i.hwEncoders.includes('av1_vaapi')) {
        plan.videoArgs = ['-vf', 'format=nv12,hwupload', '-c:v', 'av1_vaapi', '-qp', num(o, 'quality', 32, 0, 63)]
        plan.inputArgs = ['-vaapi_device', '/dev/dri/renderD128']
        plan.fallback = { videoArgs: software }
      }
      return plan
    }
  })),
  { id: 'mov-prores', name: 'MOV (ProRes 422 HQ)', extension: 'mov', description: 'Editing master with uncompressed audio', video: true, audio: true, options: [], ffmpeg: (_o, i) => ({ videoArgs: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'], audioArgs: i.hasAudio ? ['-c:a', 'pcm_s24le'] : [], extension: 'mov', container: 'mov', concatSafe: true }) },
  { id: 'gif', name: 'Animated GIF', extension: 'gif', description: 'Two-pass optimized color palette', video: true, audio: false, options: [], ffmpeg: () => ({ videoArgs: ['-c:v', 'ffv1', '-level', '3'], audioArgs: [], extension: 'gif', container: 'gif', segmentContainer: 'matroska', concatSafe: false, twoPass: 'palette' }) },
  { id: 'png-sequence', name: 'PNG sequence', extension: 'png', description: 'Numbered lossless frames in the output directory', video: true, audio: false, options: [], ffmpeg: () => ({ videoArgs: ['-c:v', 'png', '-compression_level', '3'], audioArgs: [], extension: 'png', container: 'image2', kind: 'sequence', concatSafe: false }) },
  { id: 'wav', name: 'WAV', extension: 'wav', description: 'Uncompressed stereo audio', video: false, audio: true, options: [], ffmpeg: () => ({ videoArgs: [], audioArgs: ['-c:a', 'pcm_s24le'], extension: 'wav', container: 'wav', kind: 'audio' }) },
  { id: 'mp3', name: 'MP3', extension: 'mp3', description: 'Compressed stereo audio', video: false, audio: true, options: [bitrate], ffmpeg: o => ({ videoArgs: [], audioArgs: audio(o, 'libmp3lame'), extension: 'mp3', container: 'mp3', kind: 'audio' }) }
]

export const exportersPlugin = definePlugin({
  id: 'cascade.exporters', name: 'Export formats',
  activate(ctx) { for (const exporter of exporters) ctx.exporters.register(exporter) }
})
