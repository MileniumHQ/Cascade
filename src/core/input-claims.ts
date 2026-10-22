import { Emitter } from './events'
import type { OverlayContext } from './plugin-api'

type ClaimApi = Pick<OverlayContext, 'claimInput' | 'inputClaimedByOther' | 'onInputClaims'>

/** Who currently owns pointer/keyboard input over the preview. Each overlay gets its own facade (`forOverlay`). */
export class InputClaims {
  private claims = new Set<object>()
  private changed = new Emitter<void>()

  forOverlay(): ClaimApi {
    const mine = new Set<object>()
    return {
      claimInput: () => {
        const token = {}
        mine.add(token); this.claims.add(token); this.changed.emit()
        return () => {
          if (!mine.delete(token)) return
          this.claims.delete(token); this.changed.emit()
        }
      },
      inputClaimedByOther: () => [...this.claims].some(t => !mine.has(t)),
      onInputClaims: fn => { const d = this.changed.on(fn); return () => d.dispose() }
    }
  }
}
