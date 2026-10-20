import { createMemo, Show } from 'solid-js'
import { definePlugin } from '@core/plugin-api'
import type { CascadeAPI } from '@core/app'
import { formatTimecode, fpsValue } from '@shared/time'
import { Icon } from '@ui/icon'
import { useProject, useValue } from '@ui/reactive'
import { solidMount } from './solid'

function EditInfo(props: { ctx: { app: CascadeAPI } }) {
  const app = props.ctx.app
  const project = useProject(app)
  const sel = useValue(app.selection.clips)
  const clipCount = createMemo(() => project().timelines[project().activeTimeline]?.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0)
  return (
    <span class="status-item tnum">
      <Icon name="gantt-chart" size={12} />
      {clipCount()} clip{clipCount() === 1 ? '' : 's'}
      <Show when={sel().length}> · {sel().length} selected</Show>
      <span class="status-sep" />
      {formatTimecode(app.duration(), project().settings.fps)}
    </span>
  )
}

function PreviewInfo(props: { ctx: { app: CascadeAPI } }) {
  const app = props.ctx.app
  const playing = useValue(app.playback.playing)
  const stats = useValue(app.playback.stats)
  // Quality only changes while playing (and resets on pause), so re-read it whenever stats tick.
  const label = () => {
    stats()
    playing()
    const v = (app.services.get('preview') as { quality?: { get(): number } } | undefined)?.quality?.get() ?? 1
    return v >= 1 ? 'Full' : `${Math.round(v * 100)}%`
  }
  return (
    <span class="status-item tnum" data-tip="Preview render resolution and frame rate">
      <Icon name="monitor-play" size={12} />
      Preview {label()}
      <Show when={playing()}> · {stats().fps} fps</Show>
    </span>
  )
}

function ProjectFormat(props: { ctx: { app: CascadeAPI } }) {
  const app = props.ctx.app
  const project = useProject(app)
  const fps = () => {
    const v = fpsValue(project().settings.fps)
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '')
  }
  return (
    <button class="status-item status-button tnum" data-tip="Project settings" onClick={() => app.run('project.settings')}>
      {project().settings.width} × {project().settings.height} · {fps()} fps
    </button>
  )
}

/** Status bar items: edit summary on the left, preview health on the right. */
export const statusBarPlugin = definePlugin({
  id: 'cascade.statusbar',
  name: 'Status bar',
  activate(ctx) {
    ctx.statusItems.register({ id: 'edit-info', align: 'left', order: 0, mount: solidMount(EditInfo) })
    ctx.statusItems.register({ id: 'preview-info', align: 'right', order: 0, mount: solidMount(PreviewInfo) })
    ctx.statusItems.register({ id: 'project-format', align: 'right', order: 10, mount: solidMount(ProjectFormat) })
  }
})
