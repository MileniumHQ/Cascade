import { createEffect, createSignal, For, onCleanup, onMount, Show, splitProps, type JSX, type ParentProps } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Icon } from './icon'
import './kit.css'

// ───────────────────────────── buttons ─────────────────────────────

type BtnProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'accent'
  icon?: string
  size?: 'sm' | 'md' | 'lg'
  tip?: string
  kbd?: string
}

export function Button(props: ParentProps<BtnProps>) {
  const [local, rest] = splitProps(props, ['variant', 'icon', 'size', 'children', 'class', 'tip', 'kbd'])
  return (
    <button
      {...rest}
      class={`btn btn-${local.variant ?? 'default'} btn-${local.size ?? 'md'} ${local.class ?? ''}`}
      data-tip={local.tip}
      data-kbd={local.kbd}
    >
      <Show when={local.icon}>
        <Icon name={local.icon} size={local.size === 'sm' ? 13 : 15} />
      </Show>
      <Show when={local.children}>
        <span>{local.children}</span>
      </Show>
    </button>
  )
}

export function IconButton(props: BtnProps & { active?: boolean; iconSize?: number }) {
  const [local, rest] = splitProps(props, ['icon', 'class', 'tip', 'kbd', 'active', 'iconSize', 'size'])
  return (
    <button
      {...rest}
      class={`iconbtn iconbtn-${local.size ?? 'md'} ${local.active ? 'active' : ''} ${local.class ?? ''}`}
      data-tip={local.tip}
      data-kbd={local.kbd}
    >
      <Icon name={local.icon} size={local.iconSize ?? (local.size === 'sm' ? 14 : 16)} />
    </button>
  )
}

export function Kbd(props: { keys: string }) {
  return (
    <span class="kbd">
      <For each={props.keys.split('+')}>{(k) => <kbd>{k === 'Plus' ? '+' : k.replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}</kbd>}</For>
    </span>
  )
}

// ───────────────────────────── popover ─────────────────────────────

export type Anchor = HTMLElement | { x: number; y: number }

export function placePopover(anchor: Anchor, pop: HTMLElement, placement: 'bottom' | 'top' | 'right' | 'left' = 'bottom', gap = 6) {
  const r =
    anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 }
  const pw = pop.offsetWidth
  const ph = pop.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = 0
  let y = 0
  if (placement === 'bottom' || placement === 'top') {
    x = anchor instanceof HTMLElement ? r.left : r.left
    y = placement === 'bottom' ? r.bottom + gap : r.top - ph - gap
    if (placement === 'bottom' && y + ph > vh - 8 && r.top - ph - gap > 8) y = r.top - ph - gap
    if (placement === 'top' && y < 8) y = r.bottom + gap
  } else {
    y = r.top
    x = placement === 'right' ? r.right + gap : r.left - pw - gap
    if (placement === 'right' && x + pw > vw - 8) x = r.left - pw - gap
  }
  x = Math.max(8, Math.min(vw - pw - 8, x))
  y = Math.max(8, Math.min(vh - ph - 8, y))
  pop.style.left = `${x}px`
  pop.style.top = `${y}px`
}

export function Popover(
  props: ParentProps<{
    anchor: Anchor
    onClose: () => void
    placement?: 'bottom' | 'top' | 'right' | 'left'
    class?: string
    width?: number
    align?: 'start' | 'end'
  }>
) {
  let el!: HTMLDivElement
  const place = () => {
    placePopover(props.anchor, el, props.placement)
    if (props.align === 'end' && props.anchor instanceof HTMLElement) {
      const r = props.anchor.getBoundingClientRect()
      el.style.left = `${Math.max(8, r.right - el.offsetWidth)}px`
    }
  }
  onMount(() => {
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    const down = (e: PointerEvent) => {
      if (el.contains(e.target as Node)) return
      if (props.anchor instanceof HTMLElement && props.anchor.contains(e.target as Node)) return
      props.onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    setTimeout(() => window.addEventListener('pointerdown', down, true))
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', place)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', place)
    })
  })
  return (
    <Portal>
      <div ref={el} class={`popover glass ${props.class ?? ''}`} style={{ width: props.width ? `${props.width}px` : undefined }}>
        {props.children}
      </div>
    </Portal>
  )
}

// ───────────────────────────── menu ─────────────────────────────

export interface MenuItem {
  label?: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  run?: () => void
}

export function Menu(props: { anchor: Anchor; items: MenuItem[]; onClose: () => void; placement?: 'bottom' | 'top' | 'right' }) {
  const [active, setActive] = createSignal(-1)
  const runnable = () => props.items.map((it, i) => (it.separator || it.disabled ? -1 : i)).filter((i) => i >= 0)
  const key = (e: KeyboardEvent) => {
    const r = runnable()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(r[(r.indexOf(active()) + 1) % r.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(r[(r.indexOf(active()) - 1 + r.length) % r.length])
    } else if (e.key === 'Enter' && active() >= 0) {
      e.preventDefault()
      props.items[active()].run?.()
      props.onClose()
    }
  }
  onMount(() => window.addEventListener('keydown', key))
  onCleanup(() => window.removeEventListener('keydown', key))
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement={props.placement} class="menu">
      <For each={props.items}>
        {(it, i) =>
          it.separator ? (
            <div class="menu-sep" />
          ) : (
            <div
              class={`menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''} ${active() === i() ? 'active' : ''}`}
              onPointerEnter={() => setActive(i())}
              onClick={() => {
                if (it.disabled) return
                it.run?.()
                props.onClose()
              }}
            >
              <span class="menu-icon">
                <Show when={it.checked !== undefined} fallback={<Icon name={it.icon} size={14} />}>
                  <Show when={it.checked}>
                    <Icon name="check" size={14} />
                  </Show>
                </Show>
              </span>
              <span class="menu-label">{it.label}</span>
              <Show when={it.shortcut}>
                <Kbd keys={it.shortcut!} />
              </Show>
            </div>
          )
        }
      </For>
    </Popover>
  )
}

/** Imperative context menu helper. */
const [ctxMenu, setCtxMenu] = createSignal<{ anchor: Anchor; items: MenuItem[] } | null>(null)
export const openMenu = (anchor: Anchor, items: MenuItem[]) => setCtxMenu({ anchor, items })
/** Anchor of the open menu, if any (menu bars switch menus on hover while one is open). */
export const openMenuAnchor = () => ctxMenu()?.anchor
export const openContextMenu = (e: MouseEvent, items: MenuItem[]) => {
  e.preventDefault()
  e.stopPropagation()
  setCtxMenu({ anchor: { x: e.clientX, y: e.clientY }, items })
}
export function MenuLayer() {
  return (
    <Show when={ctxMenu()} keyed>
      {(m) => <Menu anchor={m.anchor} items={m.items} onClose={() => setCtxMenu(null)} />}
    </Show>
  )
}

/** Imperative dialog host: commands and plugins show a small modal via `openDialog((close) => <Modal …/>)`. */
const [dialogs, setDialogs] = createSignal<{ id: number; render: (close: () => void) => JSX.Element }[]>([])
let dialogId = 0
export const openDialog = (render: (close: () => void) => JSX.Element) => {
  const id = ++dialogId
  setDialogs([...dialogs(), { id, render }])
  return () => setDialogs(dialogs().filter((d) => d.id !== id))
}
export function DialogLayer() {
  return (
    <For each={dialogs()}>
      {(d) => d.render(() => setDialogs(dialogs().filter((x) => x.id !== d.id)))}
    </For>
  )
}

// ───────────────────────────── tooltip ─────────────────────────────

export function TooltipLayer() {
  const [tip, setTip] = createSignal<{ text: string; kbd?: string; el: HTMLElement } | null>(null)
  let timer = 0
  let tipEl: HTMLDivElement | undefined
  const over = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null
    if (!t || !t.dataset.tip) {
      clearTimeout(timer)
      setTip(null)
      return
    }
    if (tip()?.el === t) return
    clearTimeout(timer)
    timer = window.setTimeout(() => setTip({ text: t.dataset.tip!, kbd: t.dataset.kbd, el: t }), tip() ? 0 : 450)
  }
  const hide = () => {
    clearTimeout(timer)
    setTip(null)
  }
  onMount(() => {
    window.addEventListener('mouseover', over)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, true)
  })
  onCleanup(() => {
    window.removeEventListener('mouseover', over)
    window.removeEventListener('pointerdown', hide, true)
    window.removeEventListener('wheel', hide, true)
  })
  createEffect(() => {
    const t = tip()
    if (t && tipEl) {
      const r = t.el.getBoundingClientRect()
      const w = tipEl.offsetWidth
      const h = tipEl.offsetHeight
      let x = r.left + r.width / 2 - w / 2
      let y = r.top - h - 6
      if (y < 6) y = r.bottom + 6
      x = Math.max(6, Math.min(window.innerWidth - w - 6, x))
      tipEl.style.left = `${x}px`
      tipEl.style.top = `${y}px`
    }
  })
  return (
    <Show when={tip()}>
      {(t) => (
        <Portal>
          <div ref={tipEl} class="tooltip">
            {t().text}
            <Show when={t().kbd}>
              <Kbd keys={t().kbd!} />
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}

// ───────────────────────────── inputs ─────────────────────────────

const evalMath = (s: string): number | null => {
  const clean = s.replace(/[^0-9+\-*/().,e\s%]/gi, '').replace(/,/g, '.')
  if (!clean.trim()) return null
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${clean.replace(/%/g, '')})`)()
    return typeof v === 'number' && isFinite(v) ? v : null
  } catch {
    return null
  }
}

export interface NumberFieldProps {
  value: number
  onChange: (v: number, phase: 'start' | 'update' | 'end') => void
  step?: number
  min?: number
  max?: number
  precision?: number
  suffix?: string
  prefix?: string
  class?: string
  /** px of drag per step */
  dragScale?: number
  state?: 'animated' | 'keyed' | null
  disabled?: boolean
  width?: string
}

/** Scrubbable number field: drag to change, click to type (supports math), arrows nudge. */
export function NumberField(props: NumberFieldProps) {
  const [editing, setEditing] = createSignal(false)
  let input!: HTMLInputElement
  const fmt = (v: number) => {
    const p = props.precision ?? (props.step && props.step < 1 ? Math.min(3, String(props.step).split('.')[1]?.length ?? 2) : 0)
    const n = Number.isFinite(v) ? v : 0
    return (Math.round(n * 10 ** p) / 10 ** p).toFixed(p).replace('-', '−')
  }
  const clamp = (v: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v))
  const onPointerDown = (e: PointerEvent) => {
    if (editing() || props.disabled || e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const start = props.value
    let moved = false
    let phaseStarted = false
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      if (!moved) {
        moved = true
        el.requestPointerLock?.()
      }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      const step = (props.step ?? 1) * mult
      accum += ev.movementX || 0
      const v = clamp(start + Math.round(accum / (props.dragScale ?? 2)) * step)
      props.onChange(v, phaseStarted ? 'update' : 'start')
      phaseStarted = true
    }
    let accum = 0
    const up = () => {
      el.releasePointerCapture(e.pointerId)
      document.exitPointerLock?.()
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (!moved) {
        setEditing(true)
        queueMicrotask(() => {
          input.focus()
          input.select()
        })
      } else props.onChange(props.value, 'end')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const commit = () => {
    const v = evalMath(input.value.replace('−', '-'))
    if (v !== null) {
      props.onChange(clamp(v), 'start')
      props.onChange(clamp(v), 'end')
    }
    setEditing(false)
  }
  return (
    <div
      class={`numfield ${props.state ?? ''} ${props.disabled ? 'disabled' : ''} ${editing() ? 'editing' : ''} ${props.class ?? ''}`}
      style={{ width: props.width }}
      onPointerDown={onPointerDown}
      onWheel={(e) => {
        if (!e.altKey || editing()) return
        e.preventDefault()
        const v = clamp(props.value + (e.deltaY < 0 ? 1 : -1) * (props.step ?? 1))
        props.onChange(v, 'start')
        props.onChange(v, 'end')
      }}
    >
      <Show when={props.prefix}>
        <span class="nf-affix">{props.prefix}</span>
      </Show>
      <Show when={editing()} fallback={<span class="nf-value tnum">{fmt(props.value)}</span>}>
        <input
          ref={input}
          class="nf-input tnum"
          value={fmt(props.value).replace('−', '-')}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') input.blur()
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const cur = evalMath(input.value) ?? props.value
              const v = clamp(cur + (e.key === 'ArrowUp' ? 1 : -1) * (props.step ?? 1) * (e.shiftKey ? 10 : 1))
              input.value = fmt(v).replace('−', '-')
              props.onChange(v, 'start')
              props.onChange(v, 'end')
            }
          }}
        />
      </Show>
      <Show when={props.suffix}>
        <span class="nf-affix">{props.suffix}</span>
      </Show>
    </div>
  )
}

export function TextField(
  props: { value: string; onChange: (v: string) => void; onInput?: (v: string) => void; placeholder?: string; class?: string; multiline?: boolean; autofocus?: boolean; icon?: string }
) {
  let ref: HTMLInputElement | HTMLTextAreaElement | undefined
  onMount(() => props.autofocus && ref?.focus())
  return (
    <div class={`textfield ${props.class ?? ''}`}>
      <Show when={props.icon}>
        <Icon name={props.icon} size={14} class="tf-icon" />
      </Show>
      <Show
        when={props.multiline}
        fallback={
          <input
            ref={ref as HTMLInputElement}
            value={props.value}
            placeholder={props.placeholder}
            onInput={(e) => props.onInput?.(e.currentTarget.value)}
            onChange={(e) => props.onChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
            }}
          />
        }
      >
        <textarea
          ref={ref as HTMLTextAreaElement}
          value={props.value}
          placeholder={props.placeholder}
          rows={3}
          onInput={(e) => props.onInput?.(e.currentTarget.value)}
          onChange={(e) => props.onChange(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Show>
    </div>
  )
}

export function Select<T extends string>(props: {
  value: T
  options: { value: T; label: string; icon?: string }[]
  onChange: (v: T) => void
  class?: string
  width?: string
}) {
  const [open, setOpen] = createSignal(false)
  let btn!: HTMLButtonElement
  const current = () => props.options.find((o) => o.value === props.value)
  return (
    <>
      <button ref={btn} class={`select ${open() ? 'open' : ''} ${props.class ?? ''}`} style={{ width: props.width }} onClick={() => setOpen(!open())}>
        <Show when={current()?.icon}>
          <Icon name={current()!.icon} size={13} />
        </Show>
        <span class="select-label">{current()?.label ?? props.value}</span>
        <Icon name="chevron-down" size={13} class="select-chev" />
      </button>
      <Show when={open()}>
        <Menu
          anchor={btn}
          onClose={() => setOpen(false)}
          items={props.options.map((o) => ({ label: o.label, icon: o.icon, checked: o.value === props.value, run: () => props.onChange(o.value) }))}
        />
      </Show>
    </>
  )
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; size?: 'sm' | 'md'; tip?: string }) {
  return (
    <button
      class={`toggle toggle-${props.size ?? 'md'} ${props.value ? 'on' : ''}`}
      data-tip={props.tip}
      onClick={(e) => {
        e.stopPropagation()
        props.onChange(!props.value)
      }}
    >
      <i />
    </button>
  )
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label?: string; icon?: string; tip?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented">
      <For each={props.options}>
        {(o) => (
          <button class={o.value === props.value ? 'on' : ''} data-tip={o.tip} onClick={() => props.onChange(o.value)}>
            <Show when={o.icon}>
              <Icon name={o.icon} size={14} />
            </Show>
            <Show when={o.label}>
              <span>{o.label}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

// ───────────────────────────── color ─────────────────────────────

export { parseColor, toHex } from '@shared/color'
import { parseColor, toHex } from '@shared/color'

export function ColorField(props: { value: string; onChange: (v: string, phase: 'start' | 'update' | 'end') => void; state?: 'animated' | 'keyed' | null }) {
  let picker!: HTMLInputElement
  const rgba = () => parseColor(props.value)
  return (
    <div class={`colorfield ${props.state ?? ''}`}>
      <button class="cf-swatch" style={{ '--c': props.value }} onClick={() => picker.click()}>
        <i />
      </button>
      <input
        ref={picker}
        type="color"
        class="cf-native"
        value={toHex([...rgba().slice(0, 3), 1] as [number, number, number, number]).slice(0, 7)}
        onInput={(e) => {
          const [r, g, b] = parseColor(e.currentTarget.value)
          props.onChange(toHex([r, g, b, rgba()[3]]), 'update')
        }}
        onChange={() => props.onChange(props.value, 'end')}
      />
      <input
        class="cf-hex tnum"
        value={toHex(rgba()).toUpperCase()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        onChange={(e) => {
          const v = e.currentTarget.value.trim()
          if (/^#?[0-9a-f]{3,8}$/i.test(v)) {
            props.onChange(v.startsWith('#') ? v : `#${v}`, 'start')
            props.onChange(v.startsWith('#') ? v : `#${v}`, 'end')
          }
        }}
      />
      <NumberField
        value={Math.round(rgba()[3] * 100)}
        min={0}
        max={100}
        suffix="%"
        width="58px"
        onChange={(v, phase) => {
          const [r, g, b] = rgba()
          props.onChange(toHex([r, g, b, v / 100]), phase)
        }}
      />
    </div>
  )
}

// ───────────────────────────── modal & toasts ─────────────────────────────

export function Modal(props: ParentProps<{ title: string; onClose: () => void; width?: number; icon?: string; footer?: JSX.Element }>) {
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', key)
    onCleanup(() => window.removeEventListener('keydown', key))
  })
  return (
    <Portal>
      <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="modal glass" style={{ width: `${props.width ?? 460}px` }}>
          <div class="modal-head">
            <Show when={props.icon}>
              <Icon name={props.icon} size={16} />
            </Show>
            <span>{props.title}</span>
            <IconButton icon="x" size="sm" onClick={props.onClose} />
          </div>
          <div class="modal-body">{props.children}</div>
          <Show when={props.footer}>
            <div class="modal-foot">{props.footer}</div>
          </Show>
        </div>
      </div>
    </Portal>
  )
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
}

const [toasts, setToasts] = createSignal<Toast[]>([])
export function pushToast(t: Toast) {
  setToasts((list) => [...list.slice(-4), t])
  setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), t.kind === 'error' ? 8000 : 4000)
}
export function ToastLayer() {
  const icon = { info: 'info', success: 'circle-check', warning: 'triangle-alert', error: 'circle-x' }
  return (
    <Portal>
      <div class="toasts">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast glass ${t.kind}`} onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
              <Icon name={icon[t.kind]} size={15} />
              <div>
                <div class="toast-msg">{t.message}</div>
                <Show when={t.detail}>
                  <div class="toast-detail">{t.detail}</div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </Portal>
  )
}

export function Empty(props: { icon: string; title: string; hint?: string; children?: JSX.Element }) {
  return (
    <div class="empty">
      <Icon name={props.icon} size={22} />
      <div class="empty-title">{props.title}</div>
      <Show when={props.hint}>
        <div class="empty-hint">{props.hint}</div>
      </Show>
      {props.children}
    </div>
  )
}
