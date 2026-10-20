import { Show } from 'solid-js'
import type { Value } from '@core/value'
import type { TranscribeProgress } from '@shared/ipc'
import { IconButton } from '@ui/kit'
import { Icon } from '@ui/icon'
import { useValue } from '@ui/reactive'
import { solidMount } from '../solid'
import './style.css'

export function mountCaptionProgress(el: HTMLElement, progress: Value<TranscribeProgress | null>, cancel: () => Promise<void>) {
  return solidMount(() => {
    const p = useValue(progress)
    return <Show when={p()}>{(current) => <div class="captions-progress" role="status" aria-live="polite">
      <Icon name="captions" size={13} />
      <span>{current().message}</span>
      <progress max={1} value={current().progress} aria-label="Caption generation progress" />
      <span class="tnum">{Math.round(current().progress * 100)}%</span>
      <IconButton icon="x" size="sm" tip="Cancel caption generation" aria-label="Cancel caption generation" onClick={() => void cancel()} />
    </div>}</Show>
  })(el, undefined)
}
