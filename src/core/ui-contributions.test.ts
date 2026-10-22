import { expect, it } from 'vitest'
import { CascadeApp } from './app'
import { definePlugin } from './plugin-api'
import { PluginHost } from './plugin-host'

const plugin = definePlugin({
  id: 'test.ui',
  name: 'UI',
  activate(ctx) {
    ctx.timelineDecorations.register({ id: 'd', target: 'ruler', mount() {} })
    ctx.timelineMenus.register({ id: 'm', target: 'clip', items: () => [] })
    ctx.timelineDrops.register({ id: 'drop', accepts: () => true, drop() {} })
    ctx.inspectorSections.register({ id: 'i', subject: 'transition', selection: (a) => a.selection.transitions, mount() {} })
    ctx.sourceSections.register({ id: 's', mount() {} })
    ctx.sourceItemDecorations.register({ id: 'si', mount() {} })
    ctx.snapTargets.register({ id: 'snap', points: () => [1] })
  }
})

it('registers UI contributions in the editor and ignores them in the render worker', async () => {
  for (const env of ['editor', 'render'] as const) {
    const app = new CascadeApp(env, null)
    await new PluginHost(app).activateAll([{ def: plugin, builtin: false }])
    const r = app.registries
    const ui = [r.timelineDecorations, r.timelineMenus, r.timelineDrops, r.inspectorSections, r.sourceSections, r.sourceItemDecorations].map((x) => x.all().length)
    expect(ui).toEqual(env === 'editor' ? [1, 1, 1, 1, 1, 1] : [0, 0, 0, 0, 0, 0])
    expect(r.snapTargets.all().length).toBe(1)
  }
})
