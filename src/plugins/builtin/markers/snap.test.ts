import { expect, it } from 'vitest'
import { createProject, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { constantMap } from '@core/time-remap'
import { markerSnapPoints } from './snap'

const clip = (): Clip => ({ id: 'c', type: 'unknown', name: '', start: 10 * S, duration: 4 * S, sourceIn: 20 * S, properties: [], data: {} })
it('offers visible timeline and clip markers, skipping hidden and excluded ones', () => {
  const p = createProject(''), tl = p.timelines[p.activeTimeline], c = clip()
  tl.markers = [{ id: 't', t: 3 * S, name: '', duration: S }]
  c.markers = [{ id: 'm', t: 22 * S, name: '' }, { id: 'hidden', t: 90 * S, name: '' }]
  tl.tracks[0].clips = [c]
  const points = markerSnapPoints(tl, () => constantMap(2), new Set())
  expect(points).toEqual(expect.arrayContaining([3 * S, 4 * S, 11 * S]))
  expect(points).not.toContain(90 * S)
  expect(markerSnapPoints(tl, () => constantMap(2), new Set(['m']))).not.toContain(11 * S)
  expect(markerSnapPoints(tl, () => constantMap(2), new Set(['t']))).not.toContain(3 * S)
})
