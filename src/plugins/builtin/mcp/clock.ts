import { FLICKS, type Flicks } from '@shared/time'

/** Agent-facing time: HH:MM:SS.mmm (milliseconds after the dot), the format every tool prints and accepts. */
export function clock(t: Flicks): string {
  const ms = Math.round(Math.abs(t) / (FLICKS / 1000)), pad = (v: number, n = 2) => String(v).padStart(n, '0')
  return `${t < 0 ? '-' : ''}${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}
