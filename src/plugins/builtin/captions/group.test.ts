import { describe, expect, it } from 'vitest'
import { groupCaptions } from './group'
import type { Transcript } from '@shared/ipc'
import { FLICKS as F } from '@shared/time'
const transcript = (words: { text: string; start: number; end: number }[]): Transcript => ({ path: '', model: '', language: 'en', segments: [{ text: '', start: 0, end: 100*F,
  words: words.map(w => ({ ...w, start: Math.round(w.start * F), end: Math.round(w.end * F), p: 1 })) }] })
describe('caption grouping', () => {
  it('maps a trimmed accelerated clip into integer timeline flicks', () => {
    const lines = groupCaptions(transcript([{ text: 'Hello.', start: 11, end: 12 }, { text: 'World!', start: 14, end: 15 }]), { sourceIn: 10*F, start: 20*F, speed: 2, end: 23*F })
    expect(lines).toEqual([{ text: 'Hello.', start: 20.5*F, end: 21.2*F }, { text: 'World!', start: 22*F, end: 22.7*F }])
    expect(lines.every(l => Number.isSafeInteger(l.start) && Number.isSafeInteger(l.end))).toBe(true)
  })
  it('balances at most two 42-character lines without overlapping', () => {
    const words = 'These captions should be readable and fit within two balanced lines at the lower third of the frame. Another sentence ends here.'.split(' ').map((text, i) => ({ text, start: i*0.25, end: i*0.25+0.23 }))
    const lines = groupCaptions(transcript(words), { sourceIn: 0, start: 0, speed: 1, end: 20*F })
    expect(lines.length).toBeGreaterThan(1)
    for (const [i, line] of lines.entries()) {
      expect(line.text.split('\n').length).toBeLessThanOrEqual(2)
      expect(line.text.split('\n').every(l => l.length <= 42)).toBe(true)
      expect(line.end - line.start).toBeGreaterThanOrEqual(0.7*F)
      if (i) expect(line.start).toBeGreaterThanOrEqual(lines[i-1].end)
    }
    expect(lines.map(l => l.text).join(' ').replace(/\n/g, ' ')).toBe(words.map(w => w.text).join(' '))
  })
  it('rebalances a short final word caused by a full preceding caption', () => {
    const texts = 'Together with iPhone iOS is central to how we navigate our lives and stay connected. And now'.split(' ')
    const words = texts.map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.28 }))
    const lines = groupCaptions(transcript(words), { sourceIn: 0, start: 0, speed: 1, end: 10*F })
    expect(lines.every(l => l.end - l.start >= .7*F)).toBe(true)
    expect(lines.map(l => l.text).join(' ').replace(/\n/g, ' ')).toBe(texts.join(' '))
    expect(lines.every(l => l.text.split('\n').every(s => s.length <= 42))).toBe(true)
  })
  it('does not fill long silence or extend beyond the target clip', () => {
    const lines = groupCaptions(transcript([{ text: 'Hi.', start: 1, end: 1.2 }, { text: 'Bye.', start: 10, end: 10.2 }]), { sourceIn: 0, start: 0, speed: 1, end: 10.3*F })
    expect(lines[0].end).toBe(1.7*F)
    expect(lines[1].end).toBe(10.3*F)
    expect(groupCaptions(transcript([]), { sourceIn: 0, start: 0, speed: 1, end: 10*F })).toEqual([])
  })
})
