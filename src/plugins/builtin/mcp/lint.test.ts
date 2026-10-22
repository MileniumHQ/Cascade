import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { MediaMeta } from '@shared/project'
import { FLICKS } from '@shared/time'
import { easingsPlugin } from '../easings'
import { videoPlugin } from '../media/video'
import { audioPlugin } from '../media/audio'
import { elementPlugin } from '../media/element'
import { timePropertiesPlugin } from '../properties/time'
import { audioPropertiesPlugin } from '../properties/audio'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { applyEdits, Ids } from './edits'
import { elementBox, lintTimeline, LINT_RULES, type LintMeasurements } from './lint'
import { clock } from './clock'

const S = (s: number) => Math.round(s * FLICKS)
// Width from the font size in the font string: half an em per character.
const measureText = (text: string, font: string) => text.length * 0.5 * Number(/(\d+(?:\.\d+)?)px/.exec(font)![1])

async function editor() {
  const app = new CascadeApp('editor', null)
  const host = new PluginHost(app)
  await host.activateAll([easingsPlugin, videoPlugin, audioPlugin, elementPlugin, timePropertiesPlugin, audioPropertiesPlugin, visualPropertiesPlugin, textPropertiesPlugin].map(def => ({ def, builtin: true })))
  app.doc.transact('Fixture', d => {
    d.media.src = { id: 'src', type: 'video', name: 'talk.mp4', path: '/footage/talk.mp4', meta: { duration: S(600), hasAudio: true, hasVideo: true } as MediaMeta }
    d.mediaOrder.push('src')
  })
  const ids = new Ids()
  const edit = (ops: unknown[]) => applyEdits(app, { ops }, ids)
  const clip = (ref: string) => app.timeline().tracks.flatMap(t => t.clips).find(c => c.id === ids.resolve(ref) || c.name === ref)!
  return { app, ids, edit, clip }
}
const lint = (app: CascadeApp, rules: string[], m: LintMeasurements = {}, range = { start: 0, end: S(3600) }) =>
  lintTimeline(app, range, { measureText, ...m }, { rules })

test('clean text inside the safe area at a readable pace has no issues', async () => {
  const { app, edit } = await editor()
  edit([{ op: 'add_text', text: 'Hello there', start: 0, duration: S(3) }])
  expect(lint(app, LINT_RULES.map(r => r.id))).toEqual([])
  expect(clock(S(83.5))).toBe('00:01:23.500')
})

test('safe-area, overflow and overlap of text boxes', async () => {
  const { app, edit } = await editor()
  edit([
    { op: 'add_text', text: 'Low caption', start: 0, duration: S(3), ref: 'low' },
    { op: 'set_param', clipId: 'low', propertyId: 'transform', paramId: 'position', value: [0, 0.47] },
    { op: 'add_text', text: 'A long sentence that cannot possibly fit', start: S(4), duration: S(3), ref: 'box' },
    { op: 'add_property', clipId: 'box', type: 'size' },
    { op: 'set_param', clipId: 'box', propertyId: 'size', paramId: 'size', value: [0.3, 0.05] },
    { op: 'add_text', text: 'Punchline', start: S(8), duration: S(3), ref: 'punch' },
    { op: 'add_track', kind: 'visual', ref: 'top' },
    { op: 'add_text', text: 'Caption', start: S(9), duration: S(3), trackId: 'top', ref: 'cap' }
  ])
  const issues = lint(app, ['safe-area', 'text-overflow', 'text-overlap'])
  const safe = issues.find(i => i.rule === 'safe-area')!
  expect(safe.suggestedFix).toMatch(/set_param transform\.position to \[0,0\.4\d+\]/)
  expect(issues.find(i => i.rule === 'text-overflow')?.message).toMatch(/taller than its box/)
  const overlap = issues.find(i => i.rule === 'text-overlap')!
  expect(overlap.start).toBe(S(9))
  expect(overlap.end).toBe(S(11))
  const box = elementBox(app, app.timeline().tracks.flatMap(t => t.clips).find(c => c.name.startsWith('A long'))!, S(5))!
  expect(box.w).toBeCloseTo(0.3, 5)
  expect(box.x).toBeCloseTo(0.35, 5)
})

test('reading speed and dwell', async () => {
  const { app, edit } = await editor()
  edit([
    { op: 'add_text', text: 'x'.repeat(60), start: 0, duration: S(1) },
    { op: 'add_text', text: 'Hi', start: S(2), duration: S(0.3) },
    { op: 'add_text', text: 'Title', start: S(3), duration: S(12) }
  ])
  const issues = lint(app, ['reading-speed', 'text-dwell'])
  expect(issues.map(i => [i.rule, i.severity])).toEqual([['reading-speed', 'warning'], ['text-dwell', 'warning'], ['text-dwell', 'info']])
})

test('audio: silent and clipping clips, mix clipping and dead air; missing linked audio', async () => {
  const { app, edit } = await editor()
  edit([
    { op: 'add_clip', mediaId: 'src', start: 0, sourceIn: S(10), sourceOut: S(15) },
    { op: 'add_clip', mediaId: 'src', start: S(5), sourceIn: S(20), sourceOut: S(25) }
  ])
  const audio = app.timeline().tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips)
  const issues = lint(app, ['silent-clip', 'clipping', 'dead-air'], {
    clipLevels: new Map([[audio[0].id, { peak: -60, momentaryMax: -70 }], [audio[1].id, { peak: 0, momentaryMax: -8 }]]),
    mixClipping: [S(6), S(6.1)], mixSilences: [[S(1), S(3)], [S(4), S(4.5)]]
  })
  expect(issues.map(i => i.rule)).toEqual(['silent-clip', 'dead-air', 'clipping', 'clipping'])
  expect(issues.find(i => i.rule === 'dead-air')!.suggestedFix).toBe('ripple_delete 00:00:01.150–00:00:02.850')
  // Drop the second clip's linked audio directly (a delete op would take the video with it).
  const video = app.timeline().tracks.filter(t => t.kind === 'visual').flatMap(t => t.clips)
  expect(lint(app, ['missing-linked-audio'])).toEqual([])
  app.doc.transact('Drop audio', d => { for (const t of d.timelines[d.activeTimeline].tracks) t.clips = t.clips.filter(c => c.id !== audio[1].id) })
  expect(lint(app, ['missing-linked-audio']).map(i => i.clipIds)).toEqual([[video[1].id]])
})

test('black and frozen frames from samples', async () => {
  const { app, edit } = await editor()
  edit([{ op: 'add_clip', mediaId: 'src', start: 0, sourceIn: 0, sourceOut: S(20) }])
  const frames = Array.from({ length: 20 }, (_, i) => ({ t: S(i), luma: i >= 5 && i <= 6 ? 0.01 : 0.4, diff: i >= 10 && i <= 13 ? 0 : 0.05 }))
  const issues = lint(app, ['black-frame', 'freeze'], { frames })
  expect(issues.map(i => [i.rule, i.start])).toEqual([['black-frame', S(5)], ['freeze', S(10)]])
})

test('cut rhythm, repeated source ranges and gaps', async () => {
  const { app, edit } = await editor()
  edit([
    { op: 'add_clip', mediaId: 'src', start: 0, sourceIn: S(100), sourceOut: S(109) },
    { op: 'add_clip', mediaId: 'src', sourceIn: S(200), sourceOut: S(200.3) },
    { op: 'add_clip', mediaId: 'src', sourceIn: S(210), sourceOut: S(210.3) },
    { op: 'add_clip', mediaId: 'src', sourceIn: S(220), sourceOut: S(220.3) },
    { op: 'add_clip', mediaId: 'src', start: S(12), sourceIn: S(104), sourceOut: S(106) }
  ])
  const issues = lint(app, ['cut-rhythm', 'repeated-media', 'gap'])
  expect(issues.filter(i => i.rule === 'cut-rhythm').map(i => i.message)).toEqual([expect.stringMatching(/holds 9 s .*average shot/), expect.stringMatching(/3 cuts under 0\.4 s/)])
  expect(issues.find(i => i.rule === 'repeated-media')!.message).toMatch(/same 2 s of source/)
  const gap = issues.find(i => i.rule === 'gap')!
  expect(gap.end).toBe(S(12))
  // Range filtering: the long hold and the quick cuts lie before 13 s.
  expect(lint(app, ['cut-rhythm'], {}, { start: S(13), end: S(14) })).toEqual([])
})
