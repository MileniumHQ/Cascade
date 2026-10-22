import type { CascadeAPI } from '@core/app'
import type { ParamUnit } from '@core/plugin-api'

/** Display conversion for a param's unit (frame fractions ↔ px at the project's reference size). Shared by every param editor host. */
const axisOf = (unit: ParamUnit | undefined, axis: 0 | 1 = 0): 'w' | 'h' | 'pct' | null => {
  switch (unit) {
    case 'frameX':
      return 'w'
    case 'frameY':
    case 'frameLen':
      return 'h'
    case 'frameXY':
      return axis === 0 ? 'w' : 'h'
    case 'percent':
      return 'pct'
    default:
      return null
  }
}

export const UNIT_LABELS: Record<ParamUnit, string> = {
  '': '',
  frameX: 'px',
  frameY: 'px',
  frameLen: 'px',
  frameXY: 'px',
  percent: '%',
  deg: '°',
  s: 's',
  dB: 'dB',
  Hz: 'Hz',
  x: '×'
}

export function unitHelpers(app: CascadeAPI, unit: ParamUnit | undefined) {
  const factor = (axis?: 0 | 1) => {
    const kind = axisOf(unit, axis)
    const s = app.project().settings
    return kind === 'w' ? s.width : kind === 'h' ? s.height : kind === 'pct' ? 100 : 1
  }
  return {
    toDisplay: (v: number, axis?: 0 | 1) => v * factor(axis),
    fromDisplay: (v: number, axis?: 0 | 1) => v / factor(axis),
    unitLabel: (_axis?: 0 | 1) => UNIT_LABELS[unit ?? ''] ?? ''
  }
}

