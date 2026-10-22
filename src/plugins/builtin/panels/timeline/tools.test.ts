import { afterEach, describe, expect, it, vi } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { TimelineToolContext } from '@core/plugin-api'
import { findClip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { registerTimelineTools } from './tools'
import { timePropertiesPlugin } from '../../properties/time'

async function setup() {
  const app = new CascadeApp('editor', null), host = new PluginHost(app)
  await host.activate({ id: 'tools', name: 'Tools', activate: registerTimelineTools }, true)
  app.doc.transact('setup', (d) => {
    d.media.m = { id: 'm', name: 'm', type: 'picture', meta: { duration: 50 * S } }
    d.timelines[d.activeTimeline].tracks[0].clips = [
      { id: 'one', name: 'one', type: 'picture', mediaId: 'm', start: 0, duration: 4 * S, sourceIn: 5 * S, properties: [], data: {} },
      { id: 'two', name: 'two', type: 'picture', mediaId: 'm', start: 4 * S, duration: 4 * S, sourceIn: 5 * S, properties: [], data: {} }
    ]
  })
  const trackId = app.timeline().tracks[0].id
  const context: TimelineToolContext = {
    app, hitTest: () => ({ clipId: 'one', trackId, edge: 'start' }), timeAt: (x) => Math.round(x * S), clientXAt: (t) => t / S, snap: (t) => t,
    selectClip: () => {}, moveClip: () => {}, trimClip: vi.fn(), feedback: vi.fn()
  }
  return { app, host, context }
}
const pointer = (type: string, x: number): PointerEvent => Object.assign(new Event(type), { clientX: x, clientY: 0, altKey: false, shiftKey: false }) as PointerEvent
const clip = (app: CascadeApp) => findClip(app.timeline(), 'one')!.clip

afterEach(() => vi.unstubAllGlobals())
describe('timeline tool contributions', () => {
  it('registers assigned tool keys and supports external tool install, activation and unload', async () => {
    const { app, host } = await setup()
    expect(app.registries.keybindings.all().filter((k) => k.key === 'B').map((k) => k.command)).toEqual(['timeline.tool.ripple'])
    for (const [id, key] of [['select', 'V'], ['blade', 'C'], ['ripple', 'B'], ['roll', 'R'], ['slip', 'Y'], ['slide', 'U']]) expect(app.registries.timelineTools.get(id)?.key).toBe(key)
    await host.activate({ id: 'external', name: 'External', activate(ctx) {
      ctx.timelineTools.register({ id: 'external', name: 'External', icon: 'play', cursor: 'crosshair', pointerDown() {} })
    } }, false)
    app.run('timeline.tool.external')
    expect(app.view.tool.get()).toBe('external')
    expect(app.registries.menus.all().some((m) => m.command === 'timeline.tool.external')).toBe(true)
    host.deactivate('external')
    expect(app.view.tool.get()).toBe('select')
    expect(app.registries.commands.has('timeline.tool.external')).toBe(false)
    host.deactivate('tools')
    expect(app.registries.timelineTools.all()).toEqual([])
    expect(app.registries.commands.all()).toEqual([])
  })
  it('uses cumulative pointer movement for ripple-mode head drags and ends one undo gesture', async () => {
    const { app, context } = await setup()
    vi.stubGlobal('window', new EventTarget())
    app.settings.set('timeline.rippleMode', true)
    const before = JSON.stringify(app.project())
    const cleanup = app.registries.timelineTools.get('select')!.pointerDown(pointer('pointerdown', 0), context)!
    window.dispatchEvent(pointer('pointermove', 1))
    expect(clip(app).duration).toBe(3 * S)
    window.dispatchEvent(pointer('pointermove', 2))
    expect(clip(app).duration).toBe(2 * S)
    window.dispatchEvent(pointer('pointerup', 2))
    cleanup()
    expect(context.trimClip).not.toHaveBeenCalled()
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
  })
  it('slips a ramp by cumulative integral across multiple pointer moves, and cleans up on cancellation', async () => {
    const { app, host, context } = await setup()
    vi.stubGlobal('window', new EventTarget())
    app.registries.mediaTypes.register({ id: 'picture', name: 'Picture', icon: 'film', color: '#888', track: 'visual', timeBased: true, stage: { mount: () => ({ update() {}, dispose() {} }) } }, 'test', true)
    await host.activate(timePropertiesPlugin, true)
    app.edit.updateClip('one', { speed: 1 })
    const prop = clip(app).properties[0]
    app.edit.addKeyframe('one', prop.id, 'speed', 0, 1, { id: 'linear' })
    app.edit.addKeyframe('one', prop.id, 'speed', 2 * S, 3, { id: 'linear' })
    const before = JSON.stringify(app.project())
    app.registries.timelineTools.get('slip')!.pointerDown(pointer('pointerdown', 0), context)
    window.dispatchEvent(pointer('pointermove', 1))
    expect(Math.abs(clip(app).sourceIn - 6.5 * S)).toBeLessThan(2)
    window.dispatchEvent(pointer('pointermove', 2))
    expect(Math.abs(clip(app).sourceIn - 9 * S)).toBeLessThan(2)
    window.dispatchEvent(new Event('pointercancel'))
    const after = clip(app).sourceIn
    window.dispatchEvent(pointer('pointermove', 3))
    expect(clip(app).sourceIn).toBe(after)
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
  })
})
