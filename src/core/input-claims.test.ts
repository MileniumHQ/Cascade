import { expect, it } from 'vitest'
import { InputClaims } from './input-claims'

it('lets the other overlay see a claim, never its own, and notifies on release', () => {
  const claims = new InputClaims(), path = claims.forOverlay(), gizmo = claims.forOverlay()
  let seen = 0
  const off = gizmo.onInputClaims(() => seen++)
  expect(gizmo.inputClaimedByOther()).toBe(false)
  const release = path.claimInput()
  expect(gizmo.inputClaimedByOther()).toBe(true)
  expect(path.inputClaimedByOther()).toBe(false)
  release(); release()
  expect(gizmo.inputClaimedByOther()).toBe(false)
  expect(seen).toBe(2)
  off(); path.claimInput()
  expect(seen).toBe(2)
})
