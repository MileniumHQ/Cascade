import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { definePlugin, type PanelContext } from '@core/plugin-api'
import { formatTimecode } from '@shared/time'
import { Icon } from '@ui/icon'
import { IconButton, openMenu } from '@ui/kit'
import { useProject, useRegistry, useValue } from '@ui/reactive'
import { solidMount } from '../../solid'
import { PreviewEngine } from './engine'
import { safeAreasOverlay, transformOverlay } from './overlays'
import './preview.css'

function Preview(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  const project = useProject(app)
  const time = useValue(app.playback.time)
  const playing = useValue(app.playback.playing)
  const loop = useValue(app.playback.loop)
  const rate = useValue(app.playback.rate)
  const overlays = useRegistry(app.registries.overlays)
  const [zoom, setZoom] = createSignal<'fit' | number>('fit')
  const [enabled, setEnabled] = createSignal<Set<string>>(new Set(app.registries.overlays.all().filter((o) => o.defaultEnabled !== false).map((o) => o.id)))
  let viewport!: HTMLDivElement
  let frameEl!: HTMLDivElement
  let stageHost!: HTMLDivElement
  let overlayLayer!: HTMLDivElement
  const [engine, setEngine] = createSignal<PreviewEngine | null>(null)
  const [qual, setQual] = createSignal(1)

  onMount(() => {
    const e = new PreviewEngine(app, stageHost)
    setEngine(e)
    const dq = e.quality.subscribe(setQual)
    app.services.set('preview', e)
    const layout = () => {
      const s = project().settings
      const vw = viewport.clientWidth - 24
      const vh = viewport.clientHeight - 24
      const z = zoom()
      const scale = z === 'fit' ? Math.min(vw / s.width, vh / s.height) : z
      const w = Math.max(1, Math.round(s.width * scale))
      const h = Math.max(1, Math.round(s.height * scale))
      frameEl.style.width = `${w}px`
      frameEl.style.height = `${h}px`
      e.setDisplaySize(w, h)
    }
    const ro = new ResizeObserver(layout)
    ro.observe(viewport)
    const d = app.doc.onChange.on(layout)
    createMemo(() => (zoom(), layout()))
    onCleanup(() => {
      ro.disconnect()
      d.dispose()
      dq.dispose()
      app.services.delete('preview')
      e.dispose()
    })
  })

  const pick = (ev: PointerEvent) => {
    if (ev.button !== 0 || ev.target !== overlayLayer) return
    const r = overlayLayer.getBoundingClientRect()
    const id = engine()?.hitTest(ev.clientX - r.left, ev.clientY - r.top) ?? null
    if (id) app.selection.setClips(ev.shiftKey ? [...app.selection.clips.get().filter((c) => c !== id), id] : [id])
    else if (!ev.shiftKey) app.selection.setClips([])
  }

  const tc = () => formatTimecode(time(), project().settings.fps)
  const dur = () => formatTimecode(app.duration(), project().settings.fps)

  const viewMenu = (e: MouseEvent) =>
    openMenu(e.currentTarget as HTMLElement, [
      { label: 'Fit', checked: zoom() === 'fit', run: () => setZoom('fit') },
      { label: '25%', checked: zoom() === 0.25, run: () => setZoom(0.25) },
      { label: '50%', checked: zoom() === 0.5, run: () => setZoom(0.5) },
      { label: '100%', checked: zoom() === 1, run: () => setZoom(1) },
      { separator: true },
      ...overlays().map((o) => ({
        label: o.name,
        checked: enabled().has(o.id),
        run: () => {
          const s = new Set(enabled())
          if (s.has(o.id)) s.delete(o.id)
          else s.add(o.id)
          setEnabled(s)
        }
      }))
    ])

  return (
    <div class="pv">
      <div class="pv-viewport" ref={viewport} onWheel={(e) => e.ctrlKey && (e.preventDefault(), setZoom(Math.max(0.1, Math.min(4, (zoom() === 'fit' ? frameEl.clientWidth / project().settings.width : (zoom() as number)) * (e.deltaY < 0 ? 1.1 : 0.9)))))}>
        <div class="pv-frame" ref={frameEl}>
          <div class="pv-stage" ref={stageHost} />
          <div class="pv-overlays" ref={overlayLayer} onPointerDown={pick}>
            <Show when={engine()}>
              <For each={overlays().filter((o) => enabled().has(o.id))}>
                {(o) => <OverlayMount mount={(el) => o.mount(el, engine()!.overlayContext(overlayLayer))} />}
              </For>
            </Show>
          </div>
        </div>
      </div>
      <div class="pv-bar">
        <div class="pv-tc tnum" data-tip="Current time">
          <span class="pv-tc-now">{tc()}</span>
          <span class="pv-tc-dur">/ {dur()}</span>
        </div>
        <div class="pv-transport">
          <IconButton icon="skip-back" size="sm" tip="Go to start" kbd="Home" onClick={() => app.run('playback.start')} />
          <IconButton icon="step-back" size="sm" tip="Previous frame" kbd="ArrowLeft" onClick={() => app.run('playback.stepBack')} />
          <button class={`pv-play ${playing() ? 'on' : ''}`} onClick={() => app.run('playback.toggle')} data-tip={playing() ? 'Pause' : 'Play'} data-kbd="Space">
            <Icon name={playing() ? 'pause' : 'play'} size={16} />
          </button>
          <IconButton icon="step-forward" size="sm" tip="Next frame" kbd="ArrowRight" onClick={() => app.run('playback.stepForward')} />
          <IconButton icon="skip-forward" size="sm" tip="Go to end" kbd="End" onClick={() => app.run('playback.end')} />
          <IconButton icon="repeat" size="sm" active={loop()} tip="Loop" onClick={() => app.run('playback.loop')} />
        </div>
        <div class="pv-right">
          <Show when={rate() !== 1}>
            <span class="pv-badge tnum">{rate()}×</span>
          </Show>
          <span class={`pv-badge tnum ${qual() < 1 ? 'warn' : ''}`} data-tip="Preview resolution (adapts while playing)">
            {qual() === 1 ? 'Full' : `${Math.round(qual() * 100)}%`}
          </span>
          <button class="pv-view" onClick={viewMenu} data-tip="View & overlays">
            {zoom() === 'fit' ? 'Fit' : `${Math.round((zoom() as number) * 100)}%`}
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

function OverlayMount(props: { mount: (el: HTMLElement) => void | (() => void) }) {
  let el!: HTMLDivElement
  onMount(() => {
    const c = props.mount(el)
    onCleanup(() => c?.())
  })
  return <div class="pv-overlay" ref={el} />
}

export const previewPlugin = definePlugin({
  id: 'cascade.panel.preview',
  name: 'Preview',
  activate(ctx) {
    ctx.panels.register({ id: 'preview', title: 'Preview', icon: 'monitor-play', region: 'top', order: 0, mount: solidMount(Preview) })
    ctx.overlays.register(transformOverlay)
    ctx.overlays.register(safeAreasOverlay)
  }
})

