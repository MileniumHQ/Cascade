import { expect, test } from 'vitest'
import { findClip } from '@shared/project'
import { FLICKS, frameToFlicks } from '@shared/time'
import { primitiveEditor, S } from './test-fixture'
import { buildIndex } from './transcript'
import { signedLength } from '../../../main/mcp/catalog'

const fps = { num: 30, den: 1 }
test('signed amounts accept unit signs and integer flicks, rejecting clocks, anchors, fractions and unsafe integers', () => {
  for (const v of [-FLICKS, 0, FLICKS, '-2s', '+12f', '500ms']) expect(signedLength.parse(v)).toBe(v)
  for (const v of [0.5, Number.MAX_SAFE_INTEGER + 1, '-00:01:00.000', 'w12', '2', '--2s']) expect(signedLength.safeParse(v).success).toBe(false)
})

test('transition refs, custom registry types, linked audio, duration/alignment updates and removal form one undo step', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a, b] = addThree(), before = app.project()
  const result = edit([
    { op: 'add_transition', type: 'custom-transition', from: a, to: b, duration: '500ms', params: { amount: 0.5 }, ref: 'cut' },
    { op: 'update_transition', transitionId: 'cut', duration: '1s', align: 'end', params: { amount: 0.75 } }
  ])
  expect(result).toMatch(/add_transition: ok x\d+ \(cut\)/)
  const tx = app.timeline().tracks[0].transitions![0]
  expect(tx).toMatchObject({ type: 'custom-transition', from: a, to: b, duration: S(1), align: 'end', params: { amount: 0.75 } })
  const audio = app.timeline().tracks.find(t => t.kind === 'audio')!.transitions![0]
  expect(audio).toMatchObject({ linkId: tx.linkId, duration: S(1), align: 'end' })
  app.doc.undo(); expect(app.project()).toEqual(before)
  app.doc.redo()
  edit([{ op: 'remove_transition', transitionId: tx.id }])
  expect(app.timeline().tracks.flatMap(t => t.transitions ?? [])).toHaveLength(0)
})

test.each([
  { op: 'add_transition', type: 'missing', from: 'first' },
  { op: 'add_transition', type: 'cross-dissolve' },
  { op: 'add_transition', type: 'cross-dissolve', from: 'audio' },
  { op: 'add_transition', type: 'cross-dissolve', from: 'first', to: 'last' },
  { op: 'update_transition', transitionId: 'missing', duration: '1s' },
  { op: 'remove_transition', transitionId: 'missing' }
])('$op rejects invalid transitions atomically: %j', async op => {
  const { app, edit, addThree } = await primitiveEditor(), clips = addThree()
  const aliases = { first: clips[0], last: clips[2], audio: app.timeline().tracks.find(t => t.kind === 'audio')!.clips[0].id }
  const mapped = Object.fromEntries(Object.entries(op).map(([k, v]) => [k, aliases[v as keyof typeof aliases] ?? v]))
  const before = app.project()
  expect(() => edit([{ op: 'add_marker', time: 0, name: 'temporary' }, mapped])).toThrow(/Operation 2 .*No edits applied/)
  expect(app.project()).toBe(before)
})

test('transition update validates type, parameter values and linked locks', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a, b] = addThree()
  edit([{ op: 'add_transition', type: 'cross-dissolve', from: a, to: b }])
  const tx = app.timeline().tracks[0].transitions![0].id
  for (const patch of [{ type: 'missing' }, { type: 'crossfade' }, { params: { nonexistent: 1 } }, { type: 'custom-transition', params: { amount: 5 } }]) {
    const before = app.project()
    expect(() => edit([{ op: 'update_transition', transitionId: tx, ...patch }])).toThrow(/Operation 1/)
    expect(app.project()).toBe(before)
  }
  app.edit.updateTrack(app.timeline().tracks.find(t => t.kind === 'audio')!.id, { locked: true })
  expect(() => edit([{ op: 'update_transition', transitionId: tx, duration: '2s' }])).toThrow(/locked/)
  expect(() => edit([{ op: 'remove_transition', transitionId: tx }])).toThrow(/locked/)
})

test.each(['ripple_trim', 'roll', 'slip', 'slide'] as const)('%s follows linked partners with timeline edges or signed deltas', async op => {
  const { app, edit, addThree } = await primitiveEditor(), [a, b] = addThree()
  const before = app.project()
  edit([op === 'ripple_trim' ? { op, clipId: a, edge: 'end', time: '3s' }
    : op === 'roll' ? { op, clipId: a, edge: 'end', time: '5s' }
      : { op, clipId: b, delta: op === 'slip' ? '-2s' : '+12f' }])
  const visual = app.timeline().tracks[0].clips, audio = app.timeline().tracks.find(t => t.kind === 'audio')!.clips
  expect(visual.map(c => [c.start, c.duration, c.sourceIn])).toEqual(audio.map(c => [c.start, c.duration, c.sourceIn]))
  if (op === 'ripple_trim') expect(visual.map(c => c.start)).toEqual([0, S(3), S(7)])
  if (op === 'roll') expect(visual.slice(0, 2).map(c => [c.start, c.duration])).toEqual([[0, S(5)], [S(5), S(3)]])
  if (op === 'slip') expect(visual[1].sourceIn).toBe(S(12))
  if (op === 'slide') expect(visual[1].start).toBe(S(4) + frameToFlicks(12, fps))
  app.doc.undo(); expect(app.project()).toEqual(before)
})

test.each(['ripple_trim', 'roll', 'slip', 'slide'] as const)('%s rejects locked linked partners and preserves the live document', async op => {
  const { app, edit, addThree } = await primitiveEditor(), [a] = addThree()
  app.edit.updateTrack(app.timeline().tracks.find(t => t.kind === 'audio')!.id, { locked: true })
  const before = app.project()
  expect(() => edit([op === 'ripple_trim' || op === 'roll' ? { op, clipId: a, edge: 'end', time: '3s' } : { op, clipId: a, delta: '500ms' }])).toThrow(/Operation 1 .*locked/)
  expect(app.project()).toBe(before)
})

test('close_gap closes linked tracks, rejects absent gaps; freeze_frame supports refs and rejects outside times', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a, b, c] = addThree()
  edit([{ op: 'move', clipId: c, start: '14s' }])
  edit([{ op: 'close_gap', trackId: app.timeline().tracks[0].id, time: '12s' }])
  expect(findClip(app.timeline(), c)!.clip.start).toBe(S(8))
  expect(() => edit([{ op: 'close_gap', trackId: app.timeline().tracks[0].id, time: '1s' }])).toThrow(/Operation 1 .*cannot change/)
  const before = app.project()
  expect(edit([{ op: 'freeze_frame', clipId: a, time: '2s', duration: '1s', ref: 'hold' }, { op: 'add_marker', clipId: 'hold', time: '2s', name: 'Still' }], true)).toMatch(/Dry run/)
  expect(app.project()).toBe(before)
  edit([{ op: 'freeze_frame', clipId: a, time: '2s', duration: '1s', ref: 'hold' }, { op: 'add_marker', clipId: 'hold', time: '2s', name: 'Still' }])
  expect(app.timeline().tracks[0].clips.find(c => c.start === S(2))!.markers).toHaveLength(1)
  expect(findClip(app.timeline(), b)!.clip.start).toBe(S(5))
  expect(app.timeline().tracks.find(t => t.kind === 'audio')!.clips.some(c => c.start === S(2))).toBe(false)
  expect(() => edit([{ op: 'freeze_frame', clipId: a, time: '99s' }])).toThrow(/Operation 1 .*Cannot freeze/)
})

test('marker refs and metadata, source-mapped move, update and removal are undoable', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a] = addThree()
  edit([
    { op: 'add_marker', time: '1s', name: 'Timeline', kind: 'custom-kind', color: '#ffffff', note: 'Notes', duration: '2s', ref: 'tlmark' },
    { op: 'add_marker', clipId: a, time: '2s', name: 'Source', kind: 'custom-kind', ref: 'source' },
    { op: 'update_marker', markerId: 'source', name: 'Moved', time: '3s', duration: '500ms', note: 'Source note', color: '#ff0000' },
    { op: 'update_marker', markerId: 'tlmark', time: '500ms' }
  ])
  expect(app.timeline().markers[0]).toMatchObject({ t: S(0.5), duration: S(2), kind: 'custom-kind', color: '#ffffff', note: 'Notes' })
  const marker = findClip(app.timeline(), a)!.clip.markers![0]
  expect(marker).toMatchObject({ t: S(13), name: 'Moved', duration: S(0.5), color: '#ff0000', note: 'Source note' })
  edit([{ op: 'remove_marker', markerId: marker.id }])
  expect(findClip(app.timeline(), a)!.clip.markers).toHaveLength(0)
  app.doc.undo(); expect(findClip(app.timeline(), a)!.clip.markers).toHaveLength(1)
})

test.each([
  { op: 'add_marker', time: 0, name: 'Bad', kind: 'missing' },
  { op: 'update_marker', markerId: 'missing', name: 'Bad' },
  { op: 'remove_marker', markerId: 'missing' }
])('$op rejects unknown marker IDs/kinds', async op => {
  const { app, edit } = await primitiveEditor(), before = app.project()
  expect(() => edit([op])).toThrow(/Operation 1 .*Unknown marker/)
  expect(app.project()).toBe(before)
})

test('track mixer fields validate ranges and reset to omitted defaults', async () => {
  const { app, edit } = await primitiveEditor(), trackId = app.timeline().tracks.find(t => t.kind === 'audio')!.id
  edit([{ op: 'update_track', trackId, solo: true, gain: -12, pan: -0.5 }])
  expect(app.timeline().tracks.find(t => t.id === trackId)).toMatchObject({ solo: true, gain: -12, pan: -0.5 })
  for (const patch of [{ gain: -61 }, { gain: 13 }, { pan: 1.1 }]) expect(() => edit([{ op: 'update_track', trackId, ...patch }])).toThrow()
  edit([{ op: 'update_track', trackId, solo: false, gain: 0, pan: 0 }])
  expect(app.timeline().tracks.find(t => t.id === trackId)).not.toHaveProperty('gain')
})

test('create/rename/delete timeline refs leave clip edits on the active timeline and undo together', async () => {
  const { app, edit } = await primitiveEditor(), active = app.project().activeTimeline, before = app.project()
  edit([{ op: 'create_timeline', name: 'Draft', ref: 'draft' }, { op: 'rename_timeline', timelineId: 'draft', name: 'Alternate' }, { op: 'add_text', text: 'Main', start: 0, duration: '1s' }])
  const draft = app.project().timelineOrder.find(id => id !== active)!
  expect(app.project().timelines[draft].name).toBe('Alternate')
  expect(app.project().timelines[draft].tracks.flatMap(t => t.clips)).toHaveLength(0)
  expect(app.project().activeTimeline).toBe(active)
  app.doc.undo(); expect(app.project()).toEqual(before)
  app.doc.redo()
  edit([{ op: 'delete_timeline', timelineId: draft }])
  expect(app.project().timelines[draft]).toBeUndefined()
})

test('timeline operations reject invalid schema, missing IDs and deletion of the last timeline', async () => {
  const { app, edit } = await primitiveEditor(), before = app.project()
  expect(() => edit([{ op: 'create_timeline', name: '' }])).toThrow()
  expect(() => edit([{ op: 'rename_timeline', timelineId: 'missing', name: 'Other' }])).toThrow(/Operation 1 .*Unknown timeline/)
  expect(() => edit([{ op: 'delete_timeline', timelineId: app.project().activeTimeline }])).toThrow(/Operation 1 .*Keep at least one/)
  expect(app.project()).toBe(before)
})

test('nest uses registered media types and refs; break_apart restores clips; used timelines cannot be deleted', async () => {
  const { app, edit, addThree } = await primitiveEditor(), clips = addThree(), before = app.project()
  edit([{ op: 'nest', clipIds: clips, name: 'Scene', ref: 'scene' }])
  const nested = app.timeline().tracks.flatMap(t => t.clips).find(c => app.project().media[c.mediaId!]?.timelineId)!
  const timelineId = app.project().media[nested.mediaId!].timelineId!
  expect(app.project().timelines[timelineId].name).toBe('Scene')
  expect(() => edit([{ op: 'delete_timeline', timelineId }])).toThrow(/used by a composition/)
  edit([{ op: 'break_apart', clipId: nested.id }])
  expect(app.timeline().tracks.flatMap(t => t.clips).filter(c => c.type === 'video')).toHaveLength(3)
  app.doc.undo(); app.doc.undo(); expect(app.project()).toEqual(before)
})

test('nest and break_apart use editing refusal reasons', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a] = addThree(), before = app.project()
  expect(() => edit([{ op: 'nest', clipIds: [a], mediaType: 'missing' }])).toThrow(/Operation 1 .*media type/)
  expect(() => edit([{ op: 'break_apart', clipId: a }])).toThrow(/Operation 1 .*Select a composition/)
  app.edit.updateTrack(app.timeline().tracks[0].id, { locked: true })
  expect(() => edit([{ op: 'nest', clipIds: [a] }])).toThrow(/locked/)
  app.doc.undo(); expect(app.project()).toEqual(before)
})

test('apply_preset reuses the caption style path, accepts third-party IDs and rejects other kinds/locked clips', async () => {
  const { app, edit } = await primitiveEditor()
  edit([{ op: 'add_text', text: 'Keep words', start: 0, duration: '2s', ref: 'title' }, { op: 'apply_preset', clipIds: ['title'], presetId: 'custom-style' }])
  const c = app.timeline().tracks[0].clips[0], text = c.properties.find(p => p.type === 'text')!
  expect(text.params.text.value).toBe('Keep words')
  expect(text.params.color.value).toBe('#ff0000')
  for (const presetId of ['missing', 'other-preset']) expect(() => edit([{ op: 'apply_preset', clipIds: [c.id], presetId }])).toThrow(/Operation 1 .*preset|Operation 1 .*Preset/)
  app.edit.updateTrack(app.timeline().tracks[0].id, { locked: true })
  expect(() => edit([{ op: 'apply_preset', clipIds: [c.id], presetId: 'custom-style' }])).toThrow(/locked/)
})

test('time amounts must resolve to safe integer flicks and positive durations', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a] = addThree(), before = app.project()
  for (const op of [
    { op: 'slip', clipId: a, delta: '999999999999999999999999s' },
    { op: 'add_marker', name: 'Bad', time: '999999999999999999999999s' },
    { op: 'freeze_frame', clipId: a, time: 0, duration: '0s' }
  ]) expect(() => edit([op])).toThrow(/Operation 1/)
  expect(app.project()).toBe(before)
})

test('new primitive time fields resolve transcript anchors against the staged document', async () => {
  const { app, ids, addThree } = await primitiveEditor(), [a] = addThree()
  const { applyEdits } = await import('./edits')
  const analyses = new Map([['/footage.mp4', [{ version: 1 as const, path: '/footage.mp4', range: { start: 0, end: S(120) }, language: 'en', parts: ['speech' as const], models: {},
    words: [{ text: 'Hello', start: S(11), end: S(12), p: 1 }], sentences: [{ text: 'Hello', start: S(11), end: S(12), words: [0, 1] as [number, number] }], events: [], silences: [], shots: [] }]]])
  ids.show(buildIndex(app.project(), analyses, c => app.edit.timeMap(c)).words[0].key, 'w')
  // Word source 11..12 maps to timeline 1..2 on the first clip.
  applyEdits(app, { ops: [
    { op: 'add_marker', name: 'Word', clipId: a, time: 'w1.end+500ms', ref: 'word' },
    { op: 'update_marker', markerId: 'word', time: 'w1.start' },
    { op: 'ripple_trim', clipId: a, edge: 'end', time: 'w1.end+1s' }
  ] }, ids, analyses)
  const clip = findClip(app.timeline(), a)!.clip
  expect(clip.duration).toBe(S(3))
  expect(clip.markers![0].t).toBe(S(11))
})

test('valid refs are unique across primitive result kinds', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a] = addThree(), before = app.project()
  expect(() => edit([{ op: 'add_marker', time: 0, name: 'Cue', ref: 'same' }, { op: 'freeze_frame', clipId: a, time: '1s', ref: 'same' }])).toThrow(/Operation 2 .*Duplicate\/reserved ref/)
  expect(app.project()).toBe(before)
})

test('add_transition leaves locked linked audio untouched, matching the public editing API', async () => {
  const { app, edit, addThree } = await primitiveEditor(), [a, b] = addThree()
  app.edit.updateTrack(app.timeline().tracks.find(t => t.kind === 'audio')!.id, { locked: true })
  edit([{ op: 'add_transition', type: 'cross-dissolve', from: a, to: b }])
  expect(app.timeline().tracks[0].transitions).toHaveLength(1)
  expect(app.timeline().tracks.find(t => t.kind === 'audio')!.transitions ?? []).toHaveLength(0)
})
