import { expect, test } from 'vitest'
import { CascadeApp } from './app'
import type { TimelineToolContribution } from './plugin-api'

const tool = (id: string, priority?: number): TimelineToolContribution => ({ id, name: id, icon: '', cursor: 'default', priority, pointerDown() {} })
const app = () => new CascadeApp('editor', null)

test('the initial timeline tool is the highest-priority contributed tool, not a hard-coded id', () => {
  const a = app()
  a.registries.timelineTools.register(tool('late', 20), 'p', true)
  a.registries.timelineTools.register(tool('first', 5), 'p', true)
  expect(a.view.tool.get()).toBe('first')
})
test('an active tool that disappears falls back to the best remaining contribution', () => {
  const a = app()
  a.registries.timelineTools.register(tool('base', 0), 'p', true)
  const extra = a.registries.timelineTools.register(tool('extra', 10), 'p', false)
  a.view.tool.set('extra')
  extra.dispose()
  expect(a.view.tool.get()).toBe('base')
})
test('a tool the user chose is kept while still registered', () => {
  const a = app()
  a.registries.timelineTools.register(tool('base', 0), 'p', true)
  a.registries.timelineTools.register(tool('other', 10), 'p', true)
  a.view.tool.set('other')
  a.registries.timelineTools.register(tool('more', 1), 'p', true)
  expect(a.view.tool.get()).toBe('other')
})
