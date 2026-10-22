import { describe, expect, it } from 'vitest'
import type { KeybindingContribution } from './plugin-api'
import { assignKey, effectiveBindings, findConflicts, keysOf, normalizeKey, parseSlot, removeKey, resetSlot, sanitizeOverrides, slotId } from './keymap'

const kb = (command: string, key: string, extra: Partial<KeybindingContribution> = {}): KeybindingContribution => ({ id: `${command}:${key}`, command, key, ...extra })
const defaults = [
  kb('playback.toggle', 'Space'),
  kb('timeline.split', 'S'),
  kb('timeline.split', 'Mod+B'),
  kb('playback.stepBack', 'ArrowLeft'),
  kb('playback.stepBack', 'Shift+ArrowLeft', { args: [10] }),
  kb('keyframes.delete', 'Delete', { when: 'keyframes' }),
  kb('timeline.delete', 'Delete')
]

describe('keymap', () => {
  it('normalizes modifier order and single letters', () => {
    expect(normalizeKey('Shift+Mod+z')).toBe('Mod+Shift+Z')
    expect(normalizeKey('ArrowLeft')).toBe('ArrowLeft')
  })

  it('round-trips slot ids with arguments', () => {
    const id = slotId({ command: 'playback.stepBack', args: [10] })
    expect(id).toBe('playback.stepBack#[10]')
    expect(parseSlot(id)).toEqual({ command: 'playback.stepBack', args: [10] })
    expect(parseSlot('timeline.split')).toEqual({ command: 'timeline.split' })
  })

  it('returns registry bindings untouched without overrides', () => {
    const eff = effectiveBindings(defaults)
    expect(eff).toHaveLength(defaults.length)
    expect(eff.every((b) => !b.custom)).toBe(true)
  })

  it('an override replaces all default keys of its slot only', () => {
    const eff = effectiveBindings(defaults, { 'timeline.split': ['X'] })
    expect(eff.filter((b) => b.command === 'timeline.split').map((b) => b.key)).toEqual(['X'])
    expect(eff.some((b) => b.command === 'playback.stepBack' && b.args?.[0] === 10)).toBe(true)
  })

  it('an empty override unbinds the slot', () => {
    const eff = effectiveBindings(defaults, { 'playback.toggle': [] })
    expect(eff.find((b) => b.command === 'playback.toggle')).toBeUndefined()
  })

  it('keeps the scope of a rebound slot', () => {
    const eff = effectiveBindings(defaults, { 'keyframes.delete': ['X'] })
    expect(eff.find((b) => b.command === 'keyframes.delete')).toMatchObject({ key: 'X', when: 'keyframes', custom: true })
  })

  it('detects conflicts within the same scope only', () => {
    expect(findConflicts(defaults, {}, { command: 'x' }, 'Space').map((c) => c.command)).toEqual(['playback.toggle'])
    // Delete is used globally and in the keyframes panel: different scopes.
    expect(findConflicts(defaults, {}, { command: 'x' }, 'Delete').map((c) => c.command)).toEqual(['timeline.delete'])
    expect(findConflicts(defaults, {}, { command: 'x' }, 'Delete', 'keyframes').map((c) => c.command)).toEqual(['keyframes.delete'])
    expect(findConflicts(defaults, {}, { command: 'playback.toggle' }, 'Space')).toEqual([])
  })

  it('assigning a taken key removes it from the other slot', () => {
    const next = assignKey(defaults, {}, { command: 'timeline.split' }, 'Space')
    expect(next['timeline.split']).toEqual(['S', 'Mod+B', 'Space'])
    expect(next['playback.toggle']).toEqual([])
    const eff = effectiveBindings(defaults, next)
    expect(eff.filter((b) => b.key === 'Space').map((b) => b.command)).toEqual(['timeline.split'])
  })

  it('replaces one key of a slot', () => {
    const next = assignKey(defaults, {}, { command: 'timeline.split' }, 'X', { replace: 'S' })
    expect(next['timeline.split']).toEqual(['Mod+B', 'X'])
  })

  it('drops overrides that equal the defaults', () => {
    const changed = assignKey(defaults, {}, { command: 'timeline.split' }, 'X')
    const back = removeKey(defaults, changed, { command: 'timeline.split' }, 'X')
    expect(back).toEqual({})
  })

  it('removes a key and resets a slot', () => {
    const next = removeKey(defaults, {}, { command: 'timeline.split' }, 'S')
    expect(keysOf(defaults, next, { command: 'timeline.split' })).toEqual(['Mod+B'])
    expect(resetSlot(next, { command: 'timeline.split' })).toEqual({})
    expect(keysOf(defaults, {}, { command: 'timeline.split' })).toEqual(['S', 'Mod+B'])
  })

  it('treats argument variants as separate slots', () => {
    const next = assignKey(defaults, {}, { command: 'playback.stepBack', args: [10] }, 'Alt+ArrowLeft', { replace: 'Shift+ArrowLeft' })
    expect(keysOf(defaults, next, { command: 'playback.stepBack' })).toEqual(['ArrowLeft'])
    expect(keysOf(defaults, next, { command: 'playback.stepBack', args: [10] })).toEqual(['Alt+ArrowLeft'])
  })

  it('sanitizes hand-edited overrides', () => {
    expect(sanitizeOverrides(null)).toEqual({})
    expect(sanitizeOverrides({ a: ['shift+Mod+q', 5], b: ['Shift'], c: ['Mod', 'q'], d: ['x'], e: [] })).toEqual({ c: ['Q'], d: ['X'], e: [] })
  })
})
