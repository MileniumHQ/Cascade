import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { isEmpty, markIn, markOut, markedRange, marksOf, writeMarks } from './marks'

describe('source marks', () => {
  it('marks in and out independently', () => {
    expect(markOut(markIn({}, 10), 50)).toEqual({ in: 10, out: 50 })
  })
  it('drops an out that the new in passes, and an in that the new out precedes', () => {
    expect(markIn({ in: 10, out: 50 }, 50)).toEqual({ in: 50 })
    expect(markIn({ in: 10, out: 50 }, 70)).toEqual({ in: 70 })
    expect(markOut({ in: 10, out: 50 }, 10)).toEqual({ out: 10 })
    expect(markOut({ in: 10 }, 5)).toEqual({ out: 5 })
  })
  it('clamps to the media', () => {
    expect(markIn({}, -5, 100)).toEqual({ in: 0 })
    expect(markOut({}, 500, 100)).toEqual({ out: 100 })
  })
  it('resolves the selected range with open ends', () => {
    expect(markedRange({}, 100)).toEqual({ start: 0, end: 100 })
    expect(markedRange({ in: 20 }, 100)).toEqual({ start: 20, end: 100 })
    expect(markedRange({ out: 60 }, 100)).toEqual({ start: 0, end: 60 })
    expect(markedRange({ in: 20, out: 10 }, 100)).toEqual({ start: 20, end: 100 })
  })
  it('stores marks per item in the project and removes empty ones', () => {
    const p = createProject('t')
    expect(marksOf(p, 'a')).toEqual({})
    writeMarks(p.pluginData, 'a', { in: 1, out: 2 })
    writeMarks(p.pluginData, 'b', { in: 3 })
    expect(marksOf(p, 'a')).toEqual({ in: 1, out: 2 })
    writeMarks(p.pluginData, 'a', {})
    expect(marksOf(p, 'a')).toEqual({})
    expect(marksOf(p, 'b')).toEqual({ in: 3 })
    expect(isEmpty({})).toBe(true)
  })
})
