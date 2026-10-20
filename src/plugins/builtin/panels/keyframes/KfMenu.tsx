import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import type { EasingContribution } from '@core/plugin-api'
import { Icon } from '@ui/icon'
import { Popover } from '@ui/kit'
import { useRegistry } from '@ui/reactive'
import { defaultRef, MiniCurve } from './EasingEditor'
import { resolveRefs, type KfRef } from './model'
import type { PanelState } from './context'

/** Keyframe context menu: easing presets submenu, copy/paste easing, go to, delete. */
export function KfMenu(props: { s: PanelState; at: { x: number; y: number }; refs: KfRef[]; onClose: () => void }) {
  const { app, ui } = props.s
  const easings = useRegistry(app.registries.easings)
  const clipboard = () => ui.easingClipboard.get()
  const [sub, setSub] = createSignal(false)
  const [flip, setFlip] = createSignal(false)
  let subRow!: HTMLDivElement
  let subEl: HTMLDivElement | undefined

  const resolved = () => resolveRefs(props.s.project(), props.s.project().activeTimeline, props.refs)
  const first = () => resolved()[0]
  const current = () => first()?.kf.easing
  const groups = createMemo(() => {
    const out = new Map<string, EasingContribution[]>()
    for (const e of easings()) {
      const g = e.group ?? 'Other'
      if (!out.has(g)) out.set(g, [])
      out.get(g)!.push(e)
    }
    return [...out.entries()]
  })
  const close = props.onClose
  const apply = (e: EasingContribution) => (app.edit.setKeyframeEasing(props.refs, defaultRef(e)), close())
  const openSub = () => {
    const r = subRow.getBoundingClientRect()
    setFlip(r.right + 232 > window.innerWidth)
    setSub(true)
  }
  // keep the submenu on screen vertically
  createEffect(() => {
    if (!sub() || !subEl) return
    subEl.style.top = '-6px'
    const b = subEl.getBoundingClientRect()
    const over = b.bottom - (window.innerHeight - 8)
    if (over > 0) subEl.style.top = `${-6 - Math.min(over, Math.max(0, b.top - 8))}px`
  })

  return (
    <Popover anchor={props.at} onClose={close} class="menu kf-menu">
      <div ref={subRow} class={`menu-item ${sub() ? 'active' : ''}`} onPointerEnter={openSub} onClick={openSub}>
        <span class="menu-icon">
          <Icon name="spline" size={14} />
        </span>
        <span class="menu-label">Easing</span>
        <Icon name="chevron-right" size={13} />
        <Show when={sub()}>
          <div ref={subEl} class={`kf-submenu glass ${flip() ? 'flip' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
            <For each={groups()}>
              {([group, list]) => (
                <>
                  <div class="kf-submenu-group">{group}</div>
                  <For each={list}>
                    {(e) => (
                      <div class="menu-item" onClick={() => apply(e)}>
                        <MiniCurve app={app} refr={defaultRef(e)} class="kf-menu-curve" />
                        <span class="menu-label">{e.name}</span>
                        <Show when={current()?.id === e.id}>
                          <Icon name="check" size={13} />
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="menu-item" onPointerEnter={() => setSub(false)} onClick={() => (first() && ui.easingClipboard.set(structuredClone(first().kf.easing)), close())}>
        <span class="menu-icon">
          <Icon name="copy" size={14} />
        </span>
        <span class="menu-label">Copy easing</span>
      </div>
      <div
        class={`menu-item ${clipboard() ? '' : 'disabled'}`}
        onPointerEnter={() => setSub(false)}
        onClick={() => {
          const c = clipboard()
          if (!c) return
          app.edit.setKeyframeEasing(props.refs, c)
          close()
        }}
      >
        <span class="menu-icon">
          <Icon name="clipboard-paste" size={14} />
        </span>
        <span class="menu-label">Paste easing</span>
        <Show when={clipboard()}>
          <span class="kf-menu-hint">{app.registries.easings.get(clipboard()!.id)?.name}</span>
        </Show>
      </div>
      <div class="menu-sep" />
      <Show when={props.refs.length === 1}>
        <div
          class="menu-item"
          onPointerEnter={() => setSub(false)}
          onClick={() => {
            const f = first()
            if (f) (app.playback.pause(), app.playback.seek(f.clip.start + f.kf.t))
            close()
          }}
        >
          <span class="menu-icon">
            <Icon name="locate-fixed" size={14} />
          </span>
          <span class="menu-label">Go to keyframe</span>
        </div>
      </Show>
      <div class="menu-item danger" onPointerEnter={() => setSub(false)} onClick={() => (app.edit.removeKeyframes(props.refs), app.selection.keyframes.set([]), close())}>
        <span class="menu-icon">
          <Icon name="trash-2" size={14} />
        </span>
        <span class="menu-label">Delete{props.refs.length > 1 ? ` ${props.refs.length} keyframes` : ''}</span>
        <span class="kf-menu-hint">Del</span>
      </div>
    </Popover>
  )
}
