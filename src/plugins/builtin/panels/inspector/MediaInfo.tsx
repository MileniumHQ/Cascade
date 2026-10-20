import { createMemo, For, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import { formatTimecode } from '@shared/time'
import { Empty } from '@ui/kit'
import { Icon } from '@ui/icon'
import { useProject, useValue } from '@ui/reactive'
import { TypeChip } from './ClipHeader'

const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

/** Source info for media selected in the Sources panel (when no clip is selected). */
export function MediaInfo(props: { app: CascadeAPI }) {
  const app = props.app
  const ids = useValue(app.selection.media)
  const project = useProject(app)
  const items = createMemo(() => ids().map((id) => project().media[id]).filter(Boolean))

  return (
    <Show when={items().length === 1} fallback={<Empty icon="library" title={`${items().length} sources selected`} hint="Select a single source to see its details." />}>
      {(() => {
        const m = () => items()[0]
        const rows = () => {
          const meta = m().meta
          const out: [string, string][] = []
          if (meta.duration) out.push(['Duration', formatTimecode(meta.duration, app.fps())])
          if (meta.width && meta.height) out.push(['Resolution', `${meta.width} × ${meta.height}`])
          if (meta.fps) out.push(['Frame rate', `${+(meta.fps.num / meta.fps.den).toFixed(3)} fps`])
          if (meta.videoCodec) out.push(['Video codec', meta.videoCodec])
          if (meta.audioCodec) out.push(['Audio codec', meta.audioCodec])
          if (meta.size) out.push(['File size', bytes(meta.size)])
          return out
        }
        return (
          <div class="ins-scroll">
            <div class="ins-clip">
              <div class="ins-clip-top">
                <div class="ins-clip-id">
                  <div class="ins-media-name">{m().name}</div>
                  <div class="ins-clip-meta">
                    <TypeChip app={app} type={m().type} />
                    <span class="ins-note">Source</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="ins-info">
              <For each={rows()}>
                {([k, v]) => (
                  <div class="ins-info-row">
                    <span class="ins-info-k">{k}</span>
                    <span class="ins-info-v tnum">{v}</span>
                  </div>
                )}
              </For>
              <Show when={m().path}>
                <div class="ins-info-row path">
                  <span class="ins-info-k">Path</span>
                  <span class="ins-info-v ins-path" data-tip={m().path}>
                    {m().path}
                  </span>
                </div>
              </Show>
              <Show when={!rows().length && !m().path}>
                <div class="ins-info-row">
                  <Icon name="sparkles" size={13} />
                  <span class="ins-info-v">Generated source — no file on disk.</span>
                </div>
              </Show>
            </div>
            <div class="ins-hint">Add it to the timeline to edit its properties.</div>
          </div>
        )
      })()}
    </Show>
  )
}
