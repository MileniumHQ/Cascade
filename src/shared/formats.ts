import type { FrameRate } from './time'

/** Common output formats, shared by project settings and export. */
export const RESOLUTION_PRESETS = [
  { id: '1080p', label: '1080p', sub: '1920 × 1080', w: 1920, h: 1080, icon: 'monitor' },
  { id: '4k', label: '4K UHD', sub: '3840 × 2160', w: 3840, h: 2160, icon: 'monitor' },
  { id: '720p', label: '720p', sub: '1280 × 720', w: 1280, h: 720, icon: 'monitor' },
  { id: 'vertical', label: 'Vertical', sub: '1080 × 1920', w: 1080, h: 1920, icon: 'smartphone' },
  { id: 'square', label: 'Square', sub: '1080 × 1080', w: 1080, h: 1080, icon: 'square' },
  { id: 'cinema', label: 'Cinema', sub: '2048 × 858', w: 2048, h: 858, icon: 'clapperboard' }
]

export const FPS_PRESETS: { value: string; label: string; fps: FrameRate }[] = [
  { value: '23.976', label: '23.976', fps: { num: 24000, den: 1001 } },
  { value: '24', label: '24', fps: { num: 24, den: 1 } },
  { value: '25', label: '25', fps: { num: 25, den: 1 } },
  { value: '29.97', label: '29.97', fps: { num: 30000, den: 1001 } },
  { value: '30', label: '30', fps: { num: 30, den: 1 } },
  { value: '50', label: '50', fps: { num: 50, den: 1 } },
  { value: '59.94', label: '59.94', fps: { num: 60000, den: 1001 } },
  { value: '60', label: '60', fps: { num: 60, den: 1 } },
  { value: '120', label: '120', fps: { num: 120, den: 1 } }
]

export const fpsKey = (f: FrameRate) => FPS_PRESETS.find((p) => p.fps.num === f.num && p.fps.den === f.den)?.value ?? String(f.num / f.den)
