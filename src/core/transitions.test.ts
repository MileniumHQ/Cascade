import { describe, expect, test } from 'vitest'
import { CascadeApp } from './app'
import { PluginHost } from './plugin-host'
import { createProject, type Clip, type Track, type TransitionInstance } from '@shared/project'
import { FLICKS, frameDuration } from '@shared/time'
import { nearestTransitionEdge, normalizeTransitions, transitionClipRange, transitionWindow } from './transitions'
import { clearRange, splitClip } from './timeline-ops'
import { transitionsPlugin } from '../plugins/builtin/transitions'

const S = (n: number) => Math.round(n * FLICKS)
const clip = (id: string, start: number, duration = 4): Clip => ({ id, type: 'test', name: id, start: S(start), duration: S(duration), sourceIn: S(10), properties: [], data: {} })
const track = (): Track => ({ id: 'v', kind: 'visual', name: 'V1', hidden: false, muted: false, locked: false, clips: [clip('a', 0), clip('b', 4)] })
const tx = (patch: Partial<TransitionInstance> = {}): TransitionInstance => ({ id: 'tx', type: 'unknown-plugin', from: 'a', to: 'b', duration: S(1), align: 'center', params: { custom: ['retained'] }, ...patch })

async function editor() {
  const project = createProject('Transitions')
  const tl = project.timelines[project.activeTimeline]
  const v = track(), a = { ...track(), id: 'audio', kind: 'audio' as const, clips: [clip('aa', 0), clip('ab', 4)] }
  v.clips[0].linkId = a.clips[0].linkId = 'linkA'
  v.clips[1].linkId = a.clips[1].linkId = 'linkB'
  tl.tracks = [v, a]
  const app = new CascadeApp('editor', null, project)
  await new PluginHost(app).activate(transitionsPlugin, true)
  return app
}

describe('transition geometry and normalization', () => {
  test.each(['center', 'end', 'start'] as const)('%s windows use exact integer cut geometry', align => {
    const w = transitionWindow(track(), tx({ align, duration: 5 }))!
    expect([w.start, w.end]).toEqual(align === 'center' ? [S(4) - 2, S(4) + 3] : align === 'end' ? [S(4) - 5, S(4)] : [S(4), S(4) + 5])
    expect(Number.isInteger(w.start)).toBe(true)
  })
  test('single-sided fades always lie inside their clip', () => {
    expect(transitionWindow(track(), tx({ from: undefined, to: 'a', align: 'end' }))).toMatchObject({ start: 0, end: S(1) })
    expect(transitionWindow(track(), tx({ to: undefined, align: 'start' }))).toMatchObject({ start: S(3), end: S(4) })
  })
  test('unknown types/params survive, invalid edges disappear, durations clamp and identity is stable', () => {
    const tr = track(), frame = S(1 / 30), original = tx()
    tr.transitions = [original]
    expect(normalizeTransitions(tr, frame)).toBe(tr.transitions)
    tr.transitions = [tx({ duration: S(20) }), tx({ id: 'bad', from: 'missing' }), tx({ id: 'same', from: 'a', to: 'a' })]
    const normalized = normalizeTransitions(tr, frame)!
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toEqual({ ...tx(), duration: S(4) })
    tr.transitions = [tx({ duration: NaN })]
    expect(normalizeTransitions(tr, frame)![0].duration).toBe(frame)
    tr.clips[0].duration = 1
    expect(normalizeTransitions(tr, frame)).toEqual([])
  })
  test('deletion, gaps, and cross-track references invalidate cuts', () => {
    const tr = track(); tr.transitions = [tx()]
    tr.clips[1].start++
    expect(normalizeTransitions(tr, 1)).toEqual([])
    tr.clips.pop()
    expect(normalizeTransitions(tr, 1)).toEqual([])
    expect(transitionWindow(tr, tx({ from: undefined, to: undefined }))).toBeNull()
  })
  test('one transition per clip edge, independent fades on opposite edges', () => {
    const tr = track()
    tr.transitions = [tx(), tx({ id: 'duplicate' }), tx({ id: 'in', from: undefined, to: 'a' }), tx({ id: 'out', from: 'b', to: undefined })]
    expect(normalizeTransitions(tr, 1)?.map(t => t.id)).toEqual(['tx', 'in', 'out'])
  })
  test('split and overwrite-split transfer the end edge to the right-hand piece', () => {
    for (const overwrite of [false, true]) {
      const tr = track(); tr.transitions = [tx(), tx({ id: 'in', from: undefined, to: 'a' })]
      const right = overwrite ? clearRange(tr, S(1), S(2)).created[0] : splitClip(tr, 'a', S(2))!
      expect(tr.transitions[0].from).toBe(right.id)
      expect(tr.transitions[1].to).toBe('a')
      expect(normalizeTransitions(tr, 1)).toHaveLength(2)
    }
  })
  test('nearest cuts/isolated edges and extended ranges', () => {
    const tr = track(); tr.transitions = [tx()]
    expect(nearestTransitionEdge(tr, S(3.9))).toEqual({ from: 'a', to: 'b', time: S(4) })
    expect(nearestTransitionEdge(tr, S(2))?.from).toBe('a')
    expect(nearestTransitionEdge(tr, 0)?.to).toBe('a')
    expect(nearestTransitionEdge(tr, 0, true)?.time).toBe(S(4))
    expect(transitionClipRange(tr, tr.clips[0])).toEqual({ start: 0, end: S(4.5) })
    expect(transitionClipRange(tr, tr.clips[1])).toEqual({ start: S(3.5), end: S(8) })
    expect(transitionClipRange(tr, tr.clips[1], () => false).start).toBe(S(4))
  })
})

describe('undoable editing and plugin lifecycle', () => {
  test('linked picture/sound creation, update, removal and undo/redo are atomic', async () => {
    const app = await editor()
    const id = app.edit.addTransition({ type: 'cross-dissolve', from: 'a', to: 'b' })!
    expect(id).toBeTruthy()
    const all = () => app.timeline().tracks.flatMap(t => t.transitions ?? [])
    expect(all()).toHaveLength(2)
    expect(all()[1].type).toBe('audio-crossfade')
    expect(all()[0].linkId).toBe(all()[1].linkId)
    app.edit.updateTransition(id, { duration: S(2), align: 'start' }, { gesture: 'start' })
    app.edit.updateTransition(id, { duration: S(3) }, { gesture: 'end' })
    expect(all().map(t => [t.duration, t.align])).toEqual([[S(3), 'start'], [S(3), 'start']])
    app.doc.undo()
    expect(all().map(t => t.duration)).toEqual([S(0.5), S(0.5)])
    app.doc.redo()
    expect(all()).toHaveLength(2)
    app.selection.setTransitions([id])
    app.edit.removeTransitions([all()[1].id])
    expect(all()).toHaveLength(0)
    expect(app.selection.transitions.get()).toEqual([])
    app.doc.undo()
    expect(all()).toHaveLength(2)
  })
  test('creating and resizing a fade in a gesture is one undo step', async () => {
    const app = await editor()
    const id = app.edit.addTransition({ type: 'fade', to: 'a', duration: S(0.1) }, { gesture: 'start' })!
    app.edit.updateTransition(id, { duration: S(1) }, { gesture: 'update' })
    app.edit.updateTransition(id, { duration: S(2) }, { gesture: 'end' })
    expect(app.timeline().tracks[0].transitions![0].duration).toBe(S(2))
    app.doc.undo()
    expect(app.timeline().tracks.flatMap(t => t.transitions ?? [])).toEqual([])
  })
  test('replacing a linked transition preserves the other side and unknown params on the same type', async () => {
    const app = await editor()
    const id = app.edit.addTransition({ type: 'cross-dissolve', from: 'a', to: 'b', params: { futureParam: 42 } })!
    app.edit.addTransition({ type: 'audio-crossfade', from: 'aa', to: 'ab' })
    expect(app.timeline().tracks[0].transitions![0].id).toBe(id)
    app.edit.updateTransition(id, { type: 'cross-dissolve' })
    expect(app.timeline().tracks[0].transitions![0].params.futureParam).toBe(42)
    app.edit.addTransition({ type: 'push', from: 'a', to: 'b' })
    expect(app.timeline().tracks[1].transitions![0].type).toBe('audio-crossfade')
  })
  test('linked false keeps audio independent; invalid additions and locked tracks do nothing', async () => {
    const app = await editor()
    expect(app.edit.addTransition({ type: 'missing', from: 'a', to: 'b' })).toBeNull()
    expect(app.edit.addTransition({ type: 'audio-crossfade', from: 'a', to: 'b' })).toBeNull()
    expect(app.edit.addTransition({ type: 'cross-dissolve', from: 'a', to: 'ab' })).toBeNull()
    const id = app.edit.addTransition({ type: 'fade', to: 'a', linked: false })!
    expect(app.timeline().tracks[1].transitions).toBeUndefined()
    app.edit.updateTrack('v', { locked: true })
    app.edit.removeTransitions([id]); app.edit.updateTransition(id, { duration: S(2) })
    expect(app.timeline().tracks[0].transitions![0].duration).toBe(S(0.5))
    expect(app.edit.addTransition({ type: 'fade', from: 'b' })).toBeNull()
  })
  test('all document transactions normalize in the same undo step, including plugins', async () => {
    const app = await editor()
    const id = app.edit.addTransition({ type: 'cross-dissolve', from: 'a', to: 'b' })!
    app.doc.transact('plugin timeline edit', d => { d.timelines[d.activeTimeline].tracks[0].clips[1].start += S(1) })
    expect(app.timeline().tracks[0].transitions).toEqual([])
    app.doc.undo()
    expect(app.timeline().tracks[0].transitions![0].id).toBe(id)
    app.edit.splitAt(S(2), ['a'])
    const tr = app.timeline().tracks[0]
    expect(tr.transitions![0].from).toBe(tr.clips[1].id)
    expect(tr.transitions![0].to).toBe('b')
    app.edit.deleteClips(['b'])
    expect(app.timeline().tracks.flatMap(t => t.transitions ?? [])).toEqual([])
  })
  test('type switches preserve compatible params, enforce single-sided support and duration minimums', async () => {
    const app = await editor()
    app.registries.transitions.register({ id: 'cut-only', name: 'Cut only', description: '', icon: 'layers', kinds: ['visual'], singleSided: false, params: [] }, 'test', false)
    const id = app.edit.addTransition({ type: 'wipe', to: 'a', params: { direction: 'right', softness: 0.3 } })!
    app.edit.updateTransition(id, { type: 'push' })
    expect(app.timeline().tracks[0].transitions![0].params).toEqual({ direction: 'right', easing: 'linear' })
    app.edit.updateTransition(id, { type: 'cut-only' })
    expect(app.timeline().tracks[0].transitions![0].type).toBe('push')
    expect(app.edit.addTransition({ type: 'cut-only', from: 'b' })).toBeNull()
    app.edit.updateTransition(id, { duration: 0 })
    expect(app.timeline().tracks[0].transitions![0].duration).toBe(frameDuration(app.fps()))
  })
  test('missing plugin JSON round-trip preserves data; selection is mutually exclusive', async () => {
    const app = await editor()
    app.doc.transact('unknown', d => { d.timelines[d.activeTimeline].tracks[0].transitions = [tx()] })
    const saved = JSON.parse(JSON.stringify(app.project()))
    const reopened = new CascadeApp('editor', null, saved)
    reopened.edit.renameProject('Restored')
    expect(reopened.timeline().tracks[0].transitions![0]).toEqual(tx())
    reopened.selection.setClips(['a']); reopened.selection.setTransitions(['tx'])
    expect(reopened.selection.clips.get()).toEqual([])
    reopened.selection.setClips(['b'])
    expect(reopened.selection.transitions.get()).toEqual([])
    reopened.selection.setTransitions(['tx']); reopened.selection.media.set(['m'])
    expect(reopened.selection.transitions.get()).toEqual([])
  })
  test('duplicating clips carries their transitions as fresh pairs', async () => {
    const app = await editor()
    app.edit.addTransition({ type: 'fade', to: 'a' })
    app.edit.duplicateClips(['a'])
    const all = app.timeline().tracks.flatMap(t => t.transitions ?? [])
    expect(all).toHaveLength(4)
    expect(new Set(all.map(t => t.id)).size).toBe(4)
  })
  test('default commands resolve a cut and prefer registered defaults', async () => {
    const app = await editor()
    app.selection.setClips(['a']); app.playback.seek(S(4))
    app.run('transition.addDefault')
    expect(app.timeline().tracks[0].transitions![0].type).toBe('cross-dissolve')
    app.selection.setClips(['a']); app.run('transition.addAudioDefault')
    expect(app.timeline().tracks[1].transitions![0].type).toBe('audio-crossfade')
  })
})
