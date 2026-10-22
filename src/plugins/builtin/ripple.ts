import type { CascadeAPI } from '@core/app'
import type { RippleOptions } from '@core/editing'

/**
 * The editor's Ripple mode / Ripple markers settings as the explicit options core edit primitives take.
 * Core never reads these settings; UI commands and tools resolve them here and pass them along.
 */
export const rippleOptions = (app: CascadeAPI): Required<RippleOptions> => ({
  ripple: app.settings.get<boolean>('timeline.rippleMode') ?? false,
  rippleMarkers: app.settings.get<boolean>('timeline.rippleMarkers') !== false
})
