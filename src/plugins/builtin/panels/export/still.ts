import type { CascadeAPI } from '@core/app'
import type { FrameRequest } from '@shared/ipc'
import { formatTimecode, type Flicks, type FrameRate } from '@shared/time'

export type StillFormat = 'png' | 'jpeg'

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const join = (dir: string, name: string) => `${dir.replace(/[\\/]$/, '')}/${name}`
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled'

/** "<project> 00-00-12-05.png": the playhead's timecode, filename-safe. */
export function stillFileName(project: string, time: Flicks, fps: FrameRate, ext: 'png' | 'jpg'): string {
  return `${safeName(project)} ${formatTimecode(time, fps).replace(/[:.]/g, '-')}.${ext}`
}

/** Image format implied by a file name (anything but .jpg/.jpeg is PNG). */
export const stillFormat = (path: string): StillFormat => (/\.jpe?g$/i.test(path) ? 'jpeg' : 'png')

/** The frame at the playhead at project resolution. */
export function frameRequest(app: CascadeAPI): FrameRequest {
  const project = app.project()
  return { project, timelineId: project.activeTimeline, time: app.playback.time.get(), width: project.settings.width, height: project.settings.height }
}

/** Ask where to save the frame at the playhead, render it through the export worker and write it. */
export async function exportStill(app: CascadeAPI): Promise<string | null> {
  const host = app.host
  if (!host) return null
  if (app.playback.playing.get()) app.playback.pause()
  const req = frameRequest(app)
  const session = app.services.get('session') as { path(): string | null } | undefined
  const sessionPath = session?.path()
  const dir = sessionPath ? dirname(sessionPath) : join((await host.info()).paths.documents, 'Cascade Exports')
  const name = stillFileName(req.project.name, req.time, req.project.settings.fps, 'png')
  const output = await host.dialog.saveFile({
    title: 'Export frame',
    defaultPath: join(dir, name),
    filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }]
  })
  if (!output) return null
  try {
    const written = await host.export.saveFrame({ ...req, output, format: stillFormat(output) })
    app.notify('success', 'Frame exported', written)
    return written
  } catch (error) {
    app.notify('error', 'Frame export failed', String(error))
    return null
  }
}

/** Put the frame at the playhead on the clipboard. */
export async function copyStill(app: CascadeAPI): Promise<void> {
  if (!app.host) return
  try {
    await app.host.export.copyFrame(frameRequest(app))
    app.notify('success', 'Frame copied to clipboard')
  } catch (error) {
    app.notify('error', 'Could not copy the frame', String(error))
  }
}
