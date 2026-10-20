import type { CascadeAPI } from '@core/app'
import { Value } from '@core/value'
import type { EasingRef, Id } from '@shared/project'
import type { Expansion } from './model'

/** UI state shared by the panel, its tab-strip actions and the easing sidebar (one per app). */
export interface KeyframesUi {
  showAll: Value<boolean>
  graph: Value<boolean>
  sidebar: Value<boolean>
  /** The param the graph view plots (also highlighted in the tree). */
  focusParam: Value<{ propertyId: Id; paramId: string } | null>
  easingClipboard: Value<EasingRef | null>
  /** User overrides of how much of a property is listed. */
  expansion: Value<Record<Id, Expansion>>
  /** Installed by the mounted panel: zoom the shared view to the shown clip. */
  fit: { current: (() => void) | null }
}

const uis = new WeakMap<CascadeAPI, KeyframesUi>()

export function keyframesUi(app: CascadeAPI): KeyframesUi {
  let ui = uis.get(app)
  if (!ui) {
    ui = {
      showAll: new Value(false),
      graph: new Value(false),
      sidebar: new Value(true),
      focusParam: new Value<{ propertyId: Id; paramId: string } | null>(null),
      easingClipboard: new Value<EasingRef | null>(null),
      expansion: new Value({}),
      fit: { current: null }
    }
    uis.set(app, ui)
  }
  return ui
}
