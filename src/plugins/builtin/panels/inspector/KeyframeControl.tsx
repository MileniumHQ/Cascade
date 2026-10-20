import { createSignal, onCleanup } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { ParamEditorContext } from '@core/plugin-api'
import type { Id } from '@shared/project'
import { clipOf } from './context'

export interface KfState {
  keyed: boolean
  animated: boolean
  prev: boolean
  next: boolean
  /** Playhead is inside the clip, so a keyframe can be placed. */
  inRange: boolean
}

const same = (a: KfState, b: KfState) => a.keyed === b.keyed && a.animated === b.animated && a.prev === b.prev && a.next === b.next && a.inRange === b.inRange

/** Keyframe state of a param at the playhead, re-read whenever the param context fires. */
export function useKeyframeState(app: CascadeAPI, ctx: ParamEditorContext, clipId: Id, propId: Id) {
  const read = (): KfState => {
    const clip = clipOf(app, clipId)
    const t = app.playback.time.get()
    const animated = ctx.animated
    return {
      animated,
      keyed: animated && ctx.keyed(),
      prev: animated && app.edit.adjacentKeyframe(clipId, -1, propId, ctx.def.id) !== null,
      next: animated && app.edit.adjacentKeyframe(clipId, 1, propId, ctx.def.id) !== null,
      inRange: !!clip && t >= clip.start && t <= clip.start + clip.duration
    }
  }
  const [state, set] = createSignal(read(), { equals: same })
  onCleanup(ctx.subscribe(() => set(read())))
  return state
}

const Diamond = () => (
  <svg viewBox="0 0 14 14" width="16" height="16" aria-hidden="true">
    <path d="M7 1.4 12.6 7 7 12.6 1.4 7Z" stroke-linejoin="round" />
  </svg>
)

const Chevron = (props: { dir: -1 | 1 }) => (
  <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
    <path d={props.dir < 0 ? 'M6.6 1.6 3.2 5l3.4 3.4' : 'M3.4 1.6 6.8 5 3.4 8.4'} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

/** ◀ prev keyframe · ◆ toggle keyframe at playhead · ▶ next keyframe. */
export function KeyframeControl(props: { app: CascadeAPI; clipId: Id; propId: Id; paramId: string; state: () => KfState }) {
  const { app, clipId, propId, paramId } = props
  const s = props.state
  const go = (dir: -1 | 1) => {
    const t = app.edit.adjacentKeyframe(clipId, dir, propId, paramId)
    if (t !== null) app.playback.seek(t)
  }
  const diamondTip = () =>
    !s().inRange && !s().keyed
      ? 'Move the playhead over the clip to add a keyframe'
      : s().keyed
        ? 'Remove keyframe at playhead'
        : s().animated
          ? 'Add keyframe at playhead'
          : 'Animate — add keyframe at playhead'
  return (
    <div class="ins-kf" classList={{ keyed: s().keyed, animated: s().animated }}>
      <button class="ins-kf-nav" disabled={!s().prev} data-tip="Previous keyframe" onClick={() => go(-1)}>
        <Chevron dir={-1} />
      </button>
      <button
        class="ins-kf-key"
        classList={{ keyed: s().keyed, animated: s().animated && !s().keyed }}
        disabled={!s().inRange && !s().keyed}
        data-tip={diamondTip()}
        onClick={() => app.edit.toggleKeyframe(clipId, propId, paramId)}
      >
        <Diamond />
      </button>
      <button class="ins-kf-nav" disabled={!s().next} data-tip="Next keyframe" onClick={() => go(1)}>
        <Chevron dir={1} />
      </button>
    </div>
  )
}
