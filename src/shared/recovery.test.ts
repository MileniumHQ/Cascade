import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThrottledTrigger, isRecoverable, pickRecovery, recoveryKey, type RecoveryMeta } from './recovery'

const meta = (savedAt: number, path?: string, id = 'p1'): RecoveryMeta => ({ id, name: 'X', path, savedAt })

describe('recovery selection', () => {
  it('offers snapshots newer than the file, or any snapshot without a file', () => {
    expect(isRecoverable(meta(200, '/a.cascade'), 100)).toBe(true)
    expect(isRecoverable(meta(100, '/a.cascade'), 100)).toBe(false)
    expect(isRecoverable(meta(50, '/a.cascade'), 100)).toBe(false)
    expect(isRecoverable(meta(50), null)).toBe(true)
  })
  it('picks the newest matching snapshot', () => {
    const list = [meta(300, '/a.cascade', 'a'), meta(500, '/a.cascade', 'b'), meta(900, '/b.cascade', 'c')]
    expect(pickRecovery(list, '/a.cascade', 100)?.id).toBe('b')
    expect(pickRecovery(list, '/a.cascade', 600)).toBeUndefined()
    expect(pickRecovery(list, '/none.cascade', null)).toBeUndefined()
  })
  it('sanitizes ids used as file names', () => {
    expect(recoveryKey('pr_ab12-x')).toBe('pr_ab12-x')
    expect(recoveryKey('../../etc/passwd')).toBe('_etc_passwd')
    expect(recoveryKey('')).toBe('project')
  })
})

describe('createThrottledTrigger', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('debounces but never waits past the ceiling', () => {
    const run = vi.fn()
    const t = createThrottledTrigger(run, 3000, 10000, () => Date.now())
    for (let i = 0; i < 20; i++) {
      t.poke()
      vi.advanceTimersByTime(1000)
    }
    // pokes every second for 20 s: the ceiling forces writes roughly every 10 s
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('fires once after quiet and can be cancelled', () => {
    const run = vi.fn()
    const t = createThrottledTrigger(run, 3000, 10000, () => Date.now())
    t.poke()
    vi.advanceTimersByTime(3000)
    expect(run).toHaveBeenCalledTimes(1)
    t.poke()
    t.cancel()
    vi.advanceTimersByTime(20000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
