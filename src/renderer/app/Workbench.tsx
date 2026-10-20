import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { PanelContribution, PanelRegion } from '@core/plugin-api'
import { Icon } from '../ui/icon'
import { useRegistry, useValue } from '../ui/reactive'

/**
 * The locked layout:
 *   ┌──────┬────────────────────────────┐
 *   │      │   preview      │ inspector │  top
 *   │ side ├────────────────────────────┤
 *   │      │ [Timeline][Keyframes][...] │  bottom (tabbed)
 *   └──────┴────────────────────────────┘
 * Region membership comes from LayoutService; panel contents from the panels registry.
 */
export function Workbench(props: { app: CascadeApp }) {
  const { app } = props
  const panels = useRegistry(app.registries.panels)
  const layout = useValue(app.layout.config)
  const activeBottom = useValue(app.layout.activeBottom)

  const byId = createMemo(() => new Map(panels().map((p) => [p.id, p])))
  /** Panels for a region: the configured order, then any extra panels plugins put in that region. */
  const region = (r: PanelRegion) =>
    createMemo(() => {
      const cfg = layout()[r]
      const listed = cfg.map((id) => byId().get(id)).filter(Boolean) as PanelContribution[]
      const extra = panels()
        .filter((p) => p.region === r && !cfg.includes(p.id))
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      return [...listed, ...extra]
    })
  const side = region('side')
  const top = region('top')
  const bottom = region('bottom')

  const [sideW, setSideW] = persisted('cascade.layout.side', 280)
  const [inspW, setInspW] = persisted('cascade.layout.inspector', 340)
  const [bottomH, setBottomH] = persisted('cascade.layout.bottom', 0.44)

  let topRow!: HTMLDivElement
  let main!: HTMLDivElement
  const sideRight = () => layout().sidePosition === 'right'

  const sideEl = (
    <aside class="wb-side" style={{ width: `${sideW()}px` }}>
      <PanelStack app={app} panels={side()} />
    </aside>
  )

  return (
    <div class={`workbench ${sideRight() ? 'side-right' : ''}`}>
      <div class="wb-row">
      <Show when={!sideRight()}>{sideEl}</Show>
      <Show when={!sideRight()}>
        <Splitter dir="x" onDrag={(dx) => setSideW(clamp(sideW() + dx, 200, 520))} />
      </Show>
      <div class="wb-main" ref={main}>
        <div class="wb-top" ref={topRow} style={{ height: `${(1 - bottomH()) * 100}%` }}>
          <For each={top()}>
            {(p, i) => (
              <>
                <Show when={i() > 0}>
                  <Splitter dir="x" onDrag={(dx) => setInspW(clamp(inspW() - dx, 260, topRow.clientWidth * 0.6))} />
                </Show>
                <section
                  class="wb-panel wb-top-panel"
                  data-panel={p.id}
                  style={i() === 0 ? { flex: '1 1 0' } : { width: `${inspW()}px`, flex: 'none' }}
                >
                  <PanelFrame app={app} panel={p} header={i() > 0} />
                </section>
              </>
            )}
          </For>
        </div>
        <Splitter dir="y" onDrag={(_, dy) => setBottomH(clamp(bottomH() - dy / main.clientHeight, 0.18, 0.8))} />
        <div class="wb-bottom">
          <div class="wb-tabs" role="tablist">
            <For each={bottom()}>
              {(p) => (
                <button
                  role="tab"
                  class={`wb-tab ${activeBottom() === p.id ? 'on' : ''}`}
                  aria-selected={activeBottom() === p.id}
                  onClick={() => app.layout.activeBottom.set(p.id)}
                >
                  <Icon name={p.icon} size={14} />
                  <span>{p.title}</span>
                </button>
              )}
            </For>
            <div class="wb-tabs-fill" />
            <For each={bottom()}>
              {(p) => (
                <Show when={p.actions && activeBottom() === p.id}>
                  <div class="wb-tab-actions">
                    <MountPoint mount={(el) => p.actions!(el, panelCtx(app, p.id, () => true))} />
                  </div>
                </Show>
              )}
            </For>
          </div>
          <div class="wb-bottom-body">
            <For each={bottom()}>{(p) => <BottomPanel app={app} panel={p} visible={activeBottom() === p.id} />}</For>
          </div>
        </div>
      </div>
      <Show when={sideRight()}>
        <Splitter dir="x" onDrag={(dx) => setSideW(clamp(sideW() - dx, 200, 520))} />
      </Show>
      <Show when={sideRight()}>{sideEl}</Show>
      </div>
      <StatusBar app={app} />
    </div>
  )
}

// ───────────────────────────── panel plumbing ─────────────────────────────

type VisFn = (v: boolean) => void

function panelCtx(app: CascadeApp, panelId: string, visible: () => boolean, listeners?: Set<VisFn>) {
  return {
    app,
    panelId,
    onVisibility(fn: VisFn) {
      fn(visible())
      listeners?.add(fn)
      return () => listeners?.delete(fn)
    }
  }
}

/** Calls a framework-agnostic `mount(el) => cleanup` and tears it down with the owner. */
function MountPoint(props: { mount: (el: HTMLElement) => void | (() => void); class?: string }) {
  let el!: HTMLDivElement
  onMount(() => {
    let cleanup: void | (() => void)
    try {
      cleanup = props.mount(el)
    } catch (e) {
      console.error(e)
      el.innerHTML = `<div class="panel-error">Panel crashed: ${String(e)}</div>`
    }
    onCleanup(() => cleanup?.())
  })
  return <div ref={el} class={props.class ?? 'mount'} />
}

function PanelFrame(props: { app: CascadeApp; panel: PanelContribution; header?: boolean; visible?: () => boolean; listeners?: Set<VisFn> }) {
  const ctx = () => panelCtx(props.app, props.panel.id, props.visible ?? (() => true), props.listeners)
  return (
    <>
      <Show when={props.header}>
        <header class="panel-head">
          <Icon name={props.panel.icon} size={13} />
          <span>{props.panel.title}</span>
          <div class="panel-head-fill" />
          <Show when={props.panel.actions}>
            <MountPoint class="panel-actions" mount={(el) => props.panel.actions!(el, ctx())} />
          </Show>
        </header>
      </Show>
      {/* Keyed on the contribution object so hot-reloaded panels remount. */}
      <Show when={props.panel} keyed>
        {(p) => <MountPoint class="panel-body" mount={(el) => p.mount(el, ctx())} />}
      </Show>
    </>
  )
}

/** Bottom panels mount lazily on first show and stay mounted (state survives tab switches). */
function BottomPanel(props: { app: CascadeApp; panel: PanelContribution; visible: boolean }) {
  const [mounted, setMounted] = createSignal(props.visible)
  const listeners = new Set<VisFn>()
  createEffect(() => {
    const v = props.visible
    if (v) setMounted(true)
    for (const fn of listeners) fn(v)
  })
  return (
    <section class="wb-panel wb-bottom-panel" data-panel={props.panel.id} style={{ display: props.visible ? '' : 'none' }}>
      <Show when={mounted()}>
        <PanelFrame app={props.app} panel={props.panel} visible={() => props.visible} listeners={listeners} />
      </Show>
    </section>
  )
}

function PanelStack(props: { app: CascadeApp; panels: PanelContribution[] }) {
  const active = useValue(props.app.layout.activeSide)
  const current = () => props.panels.find((p) => p.id === active()) ?? props.panels[0]
  return (
    <div class="wb-panel wb-side-panel" data-panel={current()?.id}>
      <Show when={props.panels.length > 1}>
        <div class="side-switch">
          <For each={props.panels}>
            {(p) => (
              <button class={current() === p ? 'on' : ''} data-tip={p.title} onClick={() => props.app.layout.activeSide.set(p.id)}>
                <Icon name={p.icon} size={15} />
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={current()} keyed>
        {(p) => <PanelFrame app={props.app} panel={p} header />}
      </Show>
    </div>
  )
}

function StatusBar(props: { app: CascadeApp }) {
  const items = useRegistry(props.app.registries.statusItems)
  const side = (a: 'left' | 'right') =>
    items()
      .filter((i) => (i.align ?? 'left') === a)
      .sort((x, y) => (x.order ?? 100) - (y.order ?? 100))
  return (
    <footer class="statusbar">
      <For each={side('left')}>{(i) => <MountPoint class="status-item" mount={(el) => i.mount(el, { app: props.app })} />}</For>
      <div class="status-fill" />
      <For each={side('right')}>{(i) => <MountPoint class="status-item" mount={(el) => i.mount(el, { app: props.app })} />}</For>
    </footer>
  )
}

function Splitter(props: { dir: 'x' | 'y'; onDrag: (dx: number, dy: number) => void }): JSX.Element {
  const down = (e: PointerEvent) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    let x = e.clientX
    let y = e.clientY
    const move = (ev: PointerEvent) => {
      props.onDrag(ev.clientX - x, ev.clientY - y)
      x = ev.clientX
      y = ev.clientY
    }
    const up = () => {
      el.classList.remove('dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      window.dispatchEvent(new Event('resize'))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  return <div class={`splitter splitter-${props.dir}`} onPointerDown={down} />
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

function persisted(key: string, initial: number) {
  const stored = Number(localStorage.getItem(key))
  const [get, set] = createSignal(Number.isFinite(stored) && stored > 0 ? stored : initial)
  return [
    get,
    (v: number) => {
      set(v)
      localStorage.setItem(key, String(v))
    }
  ] as const
}
