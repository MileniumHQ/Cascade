import { expect, test } from 'vitest'
import { CascadeApp } from './app'
import { findClip, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'

const clip = (id: string, start: number): Clip => ({ id, type: 'unknown', name: id, start, duration: 4 * S, sourceIn: 0, properties: [], data: {} })
function editor() {
  const app = new CascadeApp('editor', null)
  app.doc.transact('setup', d => {
    const tl = d.timelines[d.activeTimeline]
    tl.tracks[0].clips = [clip('a', 0), clip('b', 4 * S), clip('c', 8 * S)]
    tl.markers = [{ id: 'm', t: 10 * S, name: '' }]
  })
  // The UI settings must not leak into primitives that ignore them.
  app.settings.set('timeline.rippleMode', true)
  app.settings.set('timeline.rippleMarkers', false)
  return app
}
const start = (app: CascadeApp, id: string) => findClip(app.timeline(), id)!.clip.start

test('deleteClips and trimClip never ripple unless asked, whatever the UI settings say', () => {
  const app = editor()
  app.edit.deleteClips(['a'])
  expect([start(app, 'b'), start(app, 'c')]).toEqual([4 * S, 8 * S])
  app.edit.trimClip('b', 'end', 6 * S)
  expect(start(app, 'c')).toBe(8 * S)
})
test('ripple is an explicit argument and markers ripple by default', () => {
  const app = editor()
  app.edit.deleteClips(['a'], true)
  expect([start(app, 'b'), start(app, 'c')]).toEqual([0, 4 * S])
  expect(app.timeline().markers[0].t).toBe(6 * S)
  app.edit.trimClip('b', 'end', 2 * S, { ripple: true })
  expect(start(app, 'c')).toBe(2 * S)
})
test('rippleMarkers false is an explicit option, not a setting', () => {
  const app = editor()
  app.edit.deleteClips(['a'], { ripple: true, rippleMarkers: false })
  expect(app.timeline().markers[0].t).toBe(10 * S)
})
test('gap closing shifts markers unless the caller opts out', () => {
  const app = editor()
  app.doc.transact('gap', d => { d.timelines[d.activeTimeline].tracks[0].clips.shift() })
  app.edit.closeGap(app.timeline().tracks[0].id, 0)
  expect(app.timeline().markers[0].t).toBe(6 * S)
  app.doc.undo()
  app.edit.closeGap(app.timeline().tracks[0].id, 0, { rippleMarkers: false })
  expect(app.timeline().markers[0].t).toBe(10 * S)
})
