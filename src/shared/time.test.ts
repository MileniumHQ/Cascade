import { describe, expect, it } from 'vitest'
import {
  FLICKS,
  frameDuration,
  frameToFlicks,
  flicksToFrame,
  formatTimecode,
  parseFrameRate,
  parseTimecode,
  rulerStep,
  secondsToFlicks,
  snapToFrame,
  type FrameRate
} from './time'

/** Rates the timeline promises to hit with no accumulated drift. */
const RATES: FrameRate[] = [
  { num: 24_000, den: 1001 }, // 23.976
  { num: 25, den: 1 },
  { num: 30_000, den: 1001 }, // 29.97
  { num: 30, den: 1 },
  { num: 60, den: 1 },
  { num: 240, den: 1 }
]

const fps30: FrameRate = { num: 30, den: 1 }
const fps240: FrameRate = { num: 240, den: 1 }

describe('frameToFlicks / flicksToFrame', () => {
  it('round-trips every frame from 0 through 100000 with a constant frame duration', () => {
    for (const fps of RATES) {
      const step = frameToFlicks(1, fps)
      expect(step).toBeGreaterThan(0)
      for (let n = 0; n <= 100_000; n++) {
        const t = frameToFlicks(n, fps)
        const back = flicksToFrame(t, fps)
        if (t !== n * step || back !== n || frameToFlicks(back, fps) !== t) {
          throw new Error(
            `${fps.num}/${fps.den} frame ${n}: t=${t} (${n}*${step}=${n * step}) parsed as ${back}`
          )
        }
        if (n < 100_000) {
          const next = frameToFlicks(n + 1, fps)
          if (next - t !== step) {
            throw new Error(`${fps.num}/${fps.den} frame ${n} width ${next - t} !== ${step}`)
          }
        }
      }
    }
  })

  it('snaps to the nearest frame, rounding exact midpoints toward the next frame', () => {
    for (const fps of RATES) {
      const step = frameDuration(fps)
      expect(step % 2).toBe(0)
      for (const n of [0, 1, 2, 24, 30, 100, 1_000, 99_999]) {
        const start = frameToFlicks(n, fps)
        const next = frameToFlicks(n + 1, fps)
        expect(snapToFrame(start, fps)).toBe(start)
        expect(snapToFrame(next, fps)).toBe(next)
        // Half a frame is an integer flick for every rate above; Math.round half-up goes forward.
        expect(snapToFrame(start + step / 2, fps)).toBe(next)
        expect(snapToFrame(start + step / 2 - 1, fps)).toBe(start)
        expect(snapToFrame(next - 1, fps)).toBe(next)
      }
    }
  })

  it('maps every flick in [frame n, frame n+1) to frame n', () => {
    // Regression (fixed): flicksToFrame adds +1e-6 in *frame* units. One flick is only
    // fps/FLICKS frames (~4.25e-8 at 30fps, ~3.4e-7 at 240fps), so 1e-6 covers
    // the last 23 flicks of every 30fps frame and the last 2 flicks of every
    // 240fps frame. Those times are reported as the next frame.
    // formatTimecode uses the same +1e-6 and shows the next frame number.
    // Fix: bias by a fraction of a flick, not a fixed 1e-6 frames, e.g.
    //   const frames = (t * fps.num) / (FLICKS * fps.den)
    //   const oneFlick = fps.num / (FLICKS * fps.den)
    //   return Math.floor(frames + oneFlick * 0.25)
    // and the same scale inside formatTimecode's frame-within-second calculation.
    const problems: string[] = []
    const boundary = frameToFlicks(45, fps30) // exactly 1.5s
    if (flicksToFrame(boundary - 1, fps30) !== 44) {
      problems.push(`30fps flicksToFrame(1.5s - 1 flick) = ${flicksToFrame(boundary - 1, fps30)}, want 44`)
    }
    if (formatTimecode(boundary - 1, fps30) !== '00:00:01.14') {
      problems.push(`30fps format = ${formatTimecode(boundary - 1, fps30)}, want 00:00:01.14`)
    }
    const hi = frameToFlicks(10, fps240)
    if (flicksToFrame(hi - 1, fps240) !== 9) {
      problems.push(`240fps flicksToFrame = ${flicksToFrame(hi - 1, fps240)}, want 9`)
    }
    if (formatTimecode(hi - 1, fps240) !== '00:00:00.009') {
      problems.push(`240fps format = ${formatTimecode(hi - 1, fps240)}, want 00:00:00.009`)
    }
    expect(problems).toEqual([])
  })
})

describe('formatTimecode', () => {
  it('formats 30fps examples and uses 3 frame digits at 240fps', () => {
    expect(formatTimecode(0, fps30)).toBe('00:00:00.00')
    expect(formatTimecode(secondsToFlicks(1.5), fps30)).toBe('00:00:01.15')
    expect(formatTimecode(secondsToFlicks(3661), fps30)).toBe('01:01:01.00')
    expect(formatTimecode(0, fps240)).toBe('00:00:00.000')
    expect(formatTimecode(frameToFlicks(7, fps240), fps240)).toBe('00:00:00.007')
    expect(formatTimecode(frameToFlicks(120, fps240), fps240)).toBe('00:00:00.120')
  })

  it('prefixes a minus sign and formats the absolute time', () => {
    expect(formatTimecode(-secondsToFlicks(1.5), fps30)).toBe('-00:00:01.15')
    expect(formatTimecode(-secondsToFlicks(3661), fps30)).toBe('-01:01:01.00')
    expect(formatTimecode(-frameToFlicks(1, fps240), fps240)).toBe('-00:00:00.001')
  })
})

describe('parseTimecode', () => {
  it('round-trips formatTimecode for frame-aligned times', () => {
    for (const fps of RATES) {
      const step = frameDuration(fps)
      const frames = [0, 1, 2, 10, 100, 500, 2_000, 5_000]
      for (let n = 0; n <= 2_000; n++) frames.push(n)
      for (const n of frames) {
        const t = frameToFlicks(n, fps)
        const text = formatTimecode(t, fps)
        const parsed = parseTimecode(text, fps)
        if (parsed === null || formatTimecode(parsed, fps) !== text || Math.abs(parsed - t) >= step) {
          throw new Error(`${fps.num}/${fps.den} frame ${n}: ${text} → ${parsed} (t=${t}, step=${step})`)
        }
        // Integer rates share the timecode grid, so the flicks come back exactly.
        if (fps.den === 1 && parsed !== t) {
          throw new Error(`${fps.num}fps ${text}: ${parsed} !== ${t}`)
        }
      }
      const hour = secondsToFlicks(3661)
      const hourText = formatTimecode(hour, fps)
      const hourParsed = parseTimecode(hourText, fps)
      expect(hourParsed, hourText).not.toBeNull()
      expect(formatTimecode(hourParsed!, fps)).toBe(hourText)
    }

    expect(parseTimecode('00:00:00.00', fps30)).toBe(0)
    expect(parseTimecode('00:00:01.15', fps30)).toBe(secondsToFlicks(1.5))
    expect(parseTimecode('01:01:01.00', fps30)).toBe(secondsToFlicks(3661))
    expect(parseTimecode('00:00:00.000', fps240)).toBe(0)
    expect(parseTimecode('00:00:00.015', fps240)).toBe(frameToFlicks(15, fps240))
  })

  it('accepts short forms and whitespace', () => {
    expect(parseTimecode('90', fps30)).toBe(secondsToFlicks(90))
    expect(parseTimecode('1:02', fps30)).toBe(secondsToFlicks(62))
    expect(parseTimecode('1:02:03', fps30)).toBe(secondsToFlicks(3723))
    expect(parseTimecode('90.15', fps30)).toBe(secondsToFlicks(90) + frameToFlicks(15, fps30))
    expect(parseTimecode('  00:00:01.15  ', fps30)).toBe(secondsToFlicks(1.5))
  })

  it('applies +12 and -5 as frame offsets from relativeTo', () => {
    for (const fps of RATES) {
      const base = frameToFlicks(100, fps)
      expect(parseTimecode('+12', fps, 0)).toBe(frameToFlicks(12, fps))
      expect(parseTimecode(' +12 ', fps, base)).toBe(base + frameToFlicks(12, fps))
      expect(parseTimecode('-5', fps, base)).toBe(base + frameToFlicks(-5, fps))
      expect(parseTimecode('-5', fps, frameToFlicks(5, fps))).toBe(0)
    }
  })

  it('returns null for empty or non-timecode text', () => {
    expect(parseTimecode('', fps30)).toBeNull()
    expect(parseTimecode('   ', fps30)).toBeNull()
    expect(parseTimecode('abc', fps30)).toBeNull()
    expect(parseTimecode('1:2:3:4', fps30)).toBeNull()
  })

  it('parses a negative timecode produced by formatTimecode', () => {
    // Regression (fixed): formatTimecode emits a leading '-' ("-00:00:01.15"), but parseTimecode
    // only accepts a sign on bare frame offsets (/^[+-]\d+$/). The absolute form
    // falls through the timecode regex and returns null, so format/parse is not a
    // round trip for t < 0. "-5" must stay a frame offset.
    // Fix: after the offset test, strip one leading '-' and negate the parsed flicks.
    const t = -secondsToFlicks(1.5)
    const text = formatTimecode(t, fps30)
    expect(text).toBe('-00:00:01.15')
    expect(parseTimecode(text, fps30)).toBe(t)
    expect(parseTimecode('-5', fps30, frameToFlicks(20, fps30))).toBe(frameToFlicks(15, fps30))
  })
})

describe('parseFrameRate', () => {
  it('maps NTSC decimals to 1000/1001 and integers to n/1', () => {
    expect(parseFrameRate(29.97)).toEqual({ num: 30_000, den: 1001 })
    expect(parseFrameRate(23.976)).toEqual({ num: 24_000, den: 1001 })
    expect(parseFrameRate(59.94)).toEqual({ num: 60_000, den: 1001 })
    expect(parseFrameRate(119.88)).toEqual({ num: 120_000, den: 1001 })
    expect(parseFrameRate(24)).toEqual({ num: 24, den: 1 })
    expect(parseFrameRate(25)).toEqual({ num: 25, den: 1 })
    expect(parseFrameRate(30)).toEqual({ num: 30, den: 1 })
    expect(parseFrameRate(60)).toEqual({ num: 60, den: 1 })
    expect(parseFrameRate(240)).toEqual({ num: 240, den: 1 })
    // Not near an NTSC rate and not an integer: thousandths.
    expect(parseFrameRate(12.5)).toEqual({ num: 12_500, den: 1000 })
  })
})

describe('rulerStep', () => {
  it('picks a major step at least minPx wide and a minor step no larger than that', () => {
    for (const fps of RATES) {
      for (const pxPerSecond of [1, 8, 40, 80, 200, 1_000, 8_000]) {
        for (const minPx of [40, 80, 140]) {
          // The candidate list stops at one hour, so extremely zoomed-out views
          // cannot satisfy minPx. Those are covered by the fallback test.
          if (pxPerSecond * 3600 < minPx) continue
          const { major, minor } = rulerStep(pxPerSecond, fps, minPx)
          const majorPx = (major * pxPerSecond) / FLICKS
          if (majorPx < minPx || minor > major || minor <= 0) {
            throw new Error(
              `${fps.num}/${fps.den} @ ${pxPerSecond}px/s min ${minPx}: major ${major} (${majorPx}px) minor ${minor}`
            )
          }
        }
      }
    }
  })

  it('lands on whole seconds once a frame is narrower than minPx', () => {
    // 30fps, 80px/s: one frame is ~2.7px, half a second is 40px, one second is 80px.
    const step = rulerStep(80, fps30, 80)
    expect(step.major).toBe(FLICKS)
    expect(step.minor).toBe(FLICKS / 2)

    // One frame is exactly minPx, so the major tick is a single frame.
    const tight = rulerStep(2400, fps30, 80)
    expect(tight.major).toBe(frameDuration(fps30))
    expect(tight.minor).toBe(tight.major)

    // 1px/s: 60s is 60px, 120s is the first candidate that clears 80px, divided by 5.
    const wide = rulerStep(1, fps30, 80)
    expect(wide.major).toBe(FLICKS * 120)
    expect(wide.minor).toBe(FLICKS * 24)
  })

  it('falls back to a one-hour major tick when no candidate reaches minPx', () => {
    const { major, minor } = rulerStep(0.001, fps30, 80)
    expect(major).toBe(FLICKS * 3600)
    expect(minor).toBeLessThanOrEqual(major)
    expect(minor).toBeGreaterThan(0)
  })
})
