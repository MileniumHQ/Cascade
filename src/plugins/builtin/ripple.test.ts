import { expect, test } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import { findClip, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { commandsPlugin } from './commands'
import { rippleOptions } from './ripple'

const clip = (id: string, start: number): Clip => ({ id, type: 'unknown', name: id, start, duration: 4 * S, sourceIn: 0, properties: [], data: {} })
async function editor() {
  const app = new CascadeApp('editor', null)
  await new PluginHost(app).activate(commandsPlugin, true)
  app.doc.transact('setup', d => { d.timelines[d.activeTimeline].tracks[0].clips = [clip('a', 0), clip('b', 4 * S)] })
  app.selection.setClips(['a'])
  return app
}

test('rippleOptions resolves the UI settings with neutral defaults', async () => {
  const app = await editor()
  expect(rippleOptions(app)).toEqual({ ripple: false, rippleMarkers: true })
  app.settings.set('timeline.rippleMode', true)
  app.settings.set('timeline.rippleMarkers', false)
  expect(rippleOptions(app)).toEqual({ ripple: true, rippleMarkers: false })
})
test('the Delete command applies Ripple mode, the core primitive does not', async () => {
  const app = await editor()
  app.run('timeline.delete')
  expect(findClip(app.timeline(), 'b')!.clip.start).toBe(4 * S)
  app.doc.undo()
  app.selection.setClips(['a'])
  app.settings.set('timeline.rippleMode', true)
  app.run('timeline.delete')
  expect(findClip(app.timeline(), 'b')!.clip.start).toBe(0)
})
