import { expect, test } from 'vitest'
import { describeTool, modelParts, thoughtPreview } from './describe'

test('OpenCode code-mode calls show the Cascade tools they run', () => {
  const code = 'const [p, t] = await Promise.all([\n  tools.cascade["project_get"]({}),\n  tools["cascade"].timeline_get({}),\n]);'
  expect(describeTool({ title: 'execute', kind: 'other', rawInput: { code } })).toEqual({ label: 'project get, timeline get', cascade: true })
  expect(describeTool({ title: 'execute', kind: 'other', rawInput: { code: 'return 1' } })).toEqual({ label: 'Ran code', cascade: false })
})

test('Claude Code MCP titles, shell commands, reads', () => {
  expect(describeTool({ title: 'mcp__cascade__frame_get', kind: 'other' })).toEqual({ label: 'frame get', cascade: true })
  expect(describeTool({ title: 'shell', kind: 'execute', rawInput: { command: 'ls -la\necho hi' } })).toEqual({ label: 'ls -la', cascade: false, mono: true })
  expect(describeTool({ title: 'read', kind: 'read', rawInput: { path: '/tmp/a/probe.mjs' }, locations: [{ path: '/tmp/a/probe.mjs' }] })).toEqual({ label: 'Read probe.mjs', cascade: false })
  expect(describeTool({ title: 'Read README.md', kind: 'read', locations: [{ path: '/x/README.md' }] }).label).toBe('Read README.md')
})

test('model names split off the provider', () => {
  expect(modelParts('google-vertex/Claude Opus 5.5')).toEqual({ name: 'Claude Opus 5.5', provider: 'Google Vertex' })
  expect(modelParts('opencode-go/GLM-5.3')).toEqual({ name: 'GLM-5.3', provider: 'OpenCode Go' })
  expect(modelParts('my-proxy/x')).toEqual({ name: 'x', provider: 'My Proxy' })
  expect(modelParts('Claude Sonnet 5.5')).toEqual({ name: 'Claude Sonnet 5.5' })
  expect(modelParts('GPT-6 (high)')).toEqual({ name: 'GPT-6 (high)' })
})

test('thought preview is the first line without markdown', () => {
  expect(thoughtPreview('**Checking** the timeline.\nThen cut.')).toBe('Checking the timeline.')
})
