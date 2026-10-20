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
  it('never flashes a short trailing phrase squeezed against the clip end', () => {
    const sentence = (text: string, from: number, to: number) => { const t = text.split(' '); const d = (to - from) / t.length; return t.map((w, i) => ({ text: w, start: from + i * d, end: from + (i + 1) * d - 0.01 })) }
    const a = sentence('We rebuilt the widgets from the ground up so they are more beautiful and data rich.', 0, 3)
    const b = sentence('And you can now place them right on your home screen next to your favorite apps.', 3.15, 6)
    const lines = groupCaptions(transcript([...a, { text: 'Yes.', start: 3.02, end: 3.1 }, ...b]), { sourceIn: 0, start: 0, speed: 1, end: 6*F })
    // The clip ends right after "apps.": its caption has no free space after it.
    expect(lines.at(-1)!.end).toBeLessThanOrEqual(6*F)
    for (const [i, l] of lines.entries()) {
      expect(l.end - l.start).toBeGreaterThanOrEqual(0.7*F)
      if (i) expect(l.start).toBeGreaterThanOrEqual(lines[i-1].end)
    }
  })
  it('never flashes a burst of collapsed words between two full captions', () => {
    const sentence = (text: string, from: number, to: number) => { const t = text.split(' '); const d = (to - from) / t.length; return t.map((w, i) => ({ text: w, start: from + i * d, end: from + (i + 1) * d - 0.005 })) }
    const a = sentence('We rebuilt the widgets from the ground up so they are more beautiful and data rich.', 0, 3)
    // Whisper sometimes collapses a repeated phrase into ~60 ms of interpolated words.
    const burst = sentence('Go go go go.', 3.0, 3.06)
    const b = sentence('And you can now place them right on your home screen next to your favorite apps.', 3.06, 6)
    const lines = groupCaptions(transcript([...a, ...burst, ...b]), { sourceIn: 0, start: 0, speed: 1, end: 8*F })
    expect(lines.map(l => l.text.replace(/\n/g, ' ')).join(' ')).toContain('Go go go go.')
    for (const [i, l] of lines.entries()) {
      expect(l.end - l.start).toBeGreaterThanOrEqual(0.7*F)
      if (i) expect(l.start).toBeGreaterThanOrEqual(lines[i-1].end)
    }
  })
})
