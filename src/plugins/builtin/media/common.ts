import type { CascadeAPI } from '@core/app'
import type { ClipFrameState, StageUnits } from '@core/plugin-api'
import type { MediaItem, Project } from '@shared/project'

export type Fit = 'contain' | 'cover' | 'fill' | 'none'

/**
 * Size of a media box relative to the frame, as CSS container units (no px).
 * `none` uses the media's native pixel size relative to the project's reference resolution.
 */
export function fitBox(media: MediaItem | undefined, project: Project, fit: Fit = 'contain'): { width: string; height: string } {
  const fw = project.settings.width
  const fh = project.settings.height
  const mw = media?.meta.width || fw
  const mh = media?.meta.height || fh
  const A = mw / mh
  const F = fw / fh
  const pct = (n: number) => `${+n.toFixed(4)}`
  switch (fit) {
    case 'fill':
      return { width: '100cqw', height: '100cqh' }
    case 'none':
      return { width: `${pct((mw / fw) * 100)}cqw`, height: `${pct((mh / fh) * 100)}cqh` }
    case 'cover':
      return A > F ? { width: `${pct(100 * A)}cqh`, height: '100cqh' } : { width: '100cqw', height: `${pct(100 / A)}cqw` }
    default:
      return A > F ? { width: '100cqw', height: `${pct(100 / A)}cqw` } : { width: `${pct(100 * A)}cqh`, height: '100cqh' }
  }
}

export function applyBox(el: HTMLElement, box: { width: string; height: string }) {
  if (el.style.width !== box.width) el.style.width = box.width
  if (el.style.height !== box.height) el.style.height = box.height
}

/**
 * Keeps an HTMLMediaElement in step with the timeline in the preview.
 * Playing: native playback, re-sync only on real drift. Paused: seek to the exact source time.
 */
export class MediaSync {
  private seeking = false
  private pending: number | null = null
  constructor(private el: HTMLMediaElement) {
    el.addEventListener('seeked', () => {
      this.seeking = false
      if (this.pending !== null) {
        const p = this.pending
        this.pending = null
        this.seek(p)
      }
    })
  }

  private seek(t: number) {
    if (this.seeking) {
      this.pending = t
      return
    }
    this.seeking = true
    // fastSeek is keyframe-only; we want exact frames when scrubbing.
    this.el.currentTime = t
  }

  update(s: ClipFrameState, frameSec: number) {
    const el = this.el
    const target = Math.max(0, s.sourceTime)
    // Reverse playback (J) has no native support: fall through to per-frame seeking.
    if (s.playing && s.rate > 0) {
      if (el.playbackRate !== s.rate) el.playbackRate = Math.max(0.0625, Math.min(16, s.rate))
      const drift = el.currentTime - target
      if (el.paused) {
        if (Math.abs(drift) > frameSec) el.currentTime = target
        void el.play().catch(() => {})
      } else if (Math.abs(drift) > 0.25) {
        el.currentTime = target + 0.05
      }
    } else {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - target) > frameSec * 0.5) this.seek(target)
    }
  }
}

export const frameSeconds = (p: Project) => p.settings.fps.den / p.settings.fps.num

export type { StageUnits }

/**
 * Timeline clip body for media whose file is missing: a "Media offline" slate that follows the
 * runtime status. Returns null when the file is present (the caller mounts its normal body).
 */
export function mountOfflineSlate(el: HTMLElement, app: CascadeAPI, mediaId: string): (() => void) | null {
  if (!app.media.isOffline(mediaId)) return null
  const slate = document.createElement('div')
  slate.className = 'clip-offline'
  slate.textContent = 'Media offline'
  slate.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;padding:0 8px;font-size:10px;letter-spacing:.04em;color:rgba(255,255,255,.75);background:repeating-linear-gradient(135deg,rgba(0,0,0,.28) 0 6px,rgba(0,0,0,.4) 6px 12px);pointer-events:none'
  el.appendChild(slate)
  return () => slate.remove()
}
