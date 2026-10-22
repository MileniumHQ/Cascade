import { expect, it } from 'vitest'
import { LayoutService } from './app'
import type { PanelContribution } from './plugin-api'
const panel = (id: string, region: PanelContribution['region']): PanelContribution => ({ id, region, group: 'custom', title: id, icon: 'layers', mount() {} })
it('reveals contributed panels absent from the persisted layout, in either tabbed region', () => {
  const layout = new LayoutService(() => [panel('custom-side', 'side'), panel('custom-bottom', 'bottom')])
  layout.reveal('custom-side'); expect(layout.activeSide.get()).toBe('custom-side')
  layout.reveal('custom-bottom'); expect(layout.activeBottom.get()).toBe('custom-bottom')
})
it('records the shown tab of a grouped top panel', () => {
  const layout = new LayoutService(() => [panel('a', 'top'), panel('b', 'top')])
  layout.reveal('b')
  expect(layout.activeTab.get()).toEqual({ custom: 'b' })
})
