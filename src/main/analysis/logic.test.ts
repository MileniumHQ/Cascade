import { describe, expect, it } from 'vitest'
import { applyLoudness, cacheKey, completePart, EventMerger, isFiller, labelCue, sentences } from './logic'
import { FLICKS } from '../../shared/time'
import type { AnalysisWord, SourceAnalysis } from '../../shared/analysis'
const word = (text: string, start: number, end: number): AnalysisWord => ({ text, start: Math.round(start * FLICKS), end: Math.round(end * FLICKS), p: .9 })
const result = (): SourceAnalysis => ({ version: 1, path: '/media', language: 'en', range: { start: 0, end: FLICKS }, parts: [], models: {}, words: [], sentences: [], events: [], silences: [], shots: [] })
describe('source analysis', () => {
  it('flags only filled pauses, ignoring punctuation and case', () => {
    for (const text of ['Um,', 'UH!', 'erm', 'er', 'Hmm…', 'mm', 'ah', 'Umm']) expect(isFiller(text)).toBe(true)
    for (const text of ['like', 'you know', 'umbrella', 'human', '']) expect(isFiller(text)).toBe(false)
  })
  it('builds half-open sentence word ranges from punctuation and acoustic pauses', () => {
    const output = sentences([word('Hello.', 600, 601), word('A', 601.1, 601.5), word('thought', 601.5, 602), word('Next', 603, 604)])
    expect(output.map(s => s.words)).toEqual([[0, 1], [1, 3], [3, 4]])
    expect(output[1]).toMatchObject({ text: 'A thought', rate: 2 / .9 })
    expect(output[0].start).toBe(600 * FLICKS)
  })
  it('uses the median dBFS speech level as a relative loudness reference', () => {
    const words = [word('a', 0, 1), word('b', 1, 2), word('c', 2, 3), word('silent', 3, 4)]
    expect(applyLoudness(words, [{ sum: .01, count: 1 }, { sum: .04, count: 1 }, { sum: .16, count: 1 }, { sum: 0, count: 1 }])).toBeCloseTo(10 * Math.log10(.04))
    expect(words.map(w => w.db)).toEqual([-6, 0, 6, undefined])
  })
  it('maps curated AudioSet labels without mapping speech', () => {
    expect(labelCue('Music')?.cue).toBe('MUSIC')
    expect(labelCue('Gunshot, gunfire')?.cue).toBe('GUNSHOT')
    expect(labelCue('Walk, footsteps')?.cue).toBe('FOOTSTEPS')
    expect(labelCue('Speech')).toBeUndefined()
    expect(labelCue('Singing')).toBeUndefined()
  })
  it('enters above threshold, sustains with hysteresis, and unions speech overlap', () => {
    const merger = new EventMerger()
    const push = (start: number, prob: number) => merger.push({ start: start * FLICKS, end: (start + 2) * FLICKS, tags: [{ name: 'Music', prob }] })
    push(600, .3); push(601, .5); push(602, .3); push(603, .1); push(606, .6)
    const events = merger.finish([word('a', 601, 602.5), word('b', 602, 604)])
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ start: 601 * FLICKS, end: 604 * FLICKS, score: .5, underSpeech: true })
    expect(events[1].underSpeech).toBe(false)
  })
  it('merges short same-cue gaps after hysteresis closes a range', () => {
    const merger = new EventMerger()
    for (const [start, prob] of [[0, .6], [1, .1], [2, .7]]) merger.push({ start: start * FLICKS, end: (start + 2) * FLICKS, tags: [{ name: 'Music', prob }] })
    expect(merger.finish([])).toMatchObject([{ start: 0, end: 4 * FLICKS, score: .7 }])
  })
  it('normalizes cache part order and invalidates source/range/language/version inputs', () => {
    const info = { mtimeMs: 10, size: 100 }, range = { start: 0, end: FLICKS }
    const key = cacheKey('/source', info, range, 'en', ['speech', 'events'])
    expect(cacheKey('/source', info, range, 'en', ['events', 'speech', 'events'])).toBe(key)
    expect(cacheKey('/source', { ...info, size: 101 }, range, 'en', ['speech', 'events'])).not.toBe(key)
    expect(cacheKey('/source', { ...info, mtimeMs: 11 }, range, 'en', ['speech', 'events'])).not.toBe(key)
    expect(cacheKey('/source', info, { ...range, start: 1 }, 'en', ['speech', 'events'])).not.toBe(key)
    expect(cacheKey('/source', info, range, 'auto', ['speech', 'events'])).not.toBe(key)
  })
  it('preserves speech through optional model failures and continues with shots', async () => {
    const output = result(), signal = new AbortController().signal
    await completePart(output, 'speech', async () => { output.words = [word('Hello', 0, 1)] }, signal)
    await completePart(output, 'events', async () => { throw new Error('missing model') }, signal)
    await completePart(output, 'shots', async () => { output.shots = [FLICKS / 2] }, signal)
    expect(output.parts).toEqual(['speech', 'shots'])
    expect(output.errors).toEqual({ events: 'missing model' })
    expect(output.words[0].text).toBe('Hello')
    expect(output.timings?.speech).toBeGreaterThanOrEqual(0)
  })
  it('propagates cancellation instead of caching a partial result as a normal failure', async () => {
    const controller = new AbortController(), output = result()
    await expect(completePart(output, 'events', async () => { controller.abort(); throw new Error('killed') }, controller.signal)).rejects.toThrow()
    expect(output.parts).toEqual([])
    expect(output.errors).toBeUndefined()
  })
})
