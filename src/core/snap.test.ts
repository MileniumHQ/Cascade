import { expect, it } from 'vitest'
import { CascadeApp } from './app'
import { collectSnapPoints } from './snap'
import { FLICKS as S } from '@shared/time'

it('merges clip edges with snapTargets providers, honoring exclusions and skipping broken ones', () => {
  const a = new CascadeApp('editor', null)
  a.registries.snapTargets.register({ id: 'grid', points: (_a, ex) => [S, ...(ex.has('skip') ? [] : [2 * S])] }, 'test', true)
  a.registries.snapTargets.register({ id: 'broken', points: () => { throw new Error('boom') } }, 'test', true)
  const err = console.error; console.error = () => {}
  try {
    expect(collectSnapPoints(a, new Set(), [3 * S])).toEqual([0, S, 2 * S, 3 * S])
    expect(collectSnapPoints(a, new Set(['skip']))).toEqual([0, S])
  } finally { console.error = err }
})
