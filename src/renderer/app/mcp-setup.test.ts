import { expect, test } from 'vitest'
import { MCP_CLIENTS, mcpSetup } from './mcp-setup'

const info = { url: 'http://127.0.0.1:47823/mcp', enabled: true, token: 'tok', platform: 'linux', stdio: { command: '/opt/Cascade/cascade', args: ['--mcp-stdio'] } }

test('claude code commands follow the scope', () => {
  expect(mcpSetup('claude', 'project', 'http', info).text).toBe('claude mcp add --scope project --transport http cascade http://127.0.0.1:47823/mcp --header "Authorization: Bearer tok"')
  expect(mcpSetup('claude', 'global', 'stdio', info).text).toBe('claude mcp add --scope user --transport stdio cascade -- env -u ELECTRON_RUN_AS_NODE /opt/Cascade/cascade --mcp-stdio')
})

test('config files: project vs global paths, valid JSON with the token', () => {
  expect(mcpSetup('cursor', 'project', 'http', info).target).toBe('.cursor/mcp.json')
  expect(mcpSetup('cursor', 'global', 'http', info).target).toBe('~/.cursor/mcp.json')
  for (const { value } of MCP_CLIENTS) for (const scope of ['project', 'global'] as const) for (const transport of ['http', 'stdio'] as const) {
    const s = mcpSetup(value, scope, transport, info)
    if (s.kind === 'json') expect(() => JSON.parse(s.text)).not.toThrow()
    expect(s.text).toContain(transport === 'http' ? 'tok' : '--mcp-stdio')
  }
  expect(JSON.parse(mcpSetup('opencode', 'global', 'stdio', info).text).mcp.cascade.command).toEqual(['env', '-u', 'ELECTRON_RUN_AS_NODE', '/opt/Cascade/cascade', '--mcp-stdio'])
  expect(mcpSetup('codex', 'global', 'http', info).text).toBe('[mcp_servers.cascade]\nurl = "http://127.0.0.1:47823/mcp"\nhttp_headers = { "Authorization" = "Bearer tok" }\n')
})

test('a dev profile is passed to the stdio proxy and paths with spaces are quoted', () => {
  const dev = { ...info, stdio: { command: '/home/me/My Apps/electron', args: ['/home/me/Cascade', '--mcp-stdio'], env: { CASCADE_USER_DATA: '/tmp/p' } } }
  expect(mcpSetup('claude', 'project', 'stdio', dev).text).toContain("-- env -u ELECTRON_RUN_AS_NODE CASCADE_USER_DATA=/tmp/p '/home/me/My Apps/electron' /home/me/Cascade --mcp-stdio")
})

test('Windows stdio command uses double quotes', () => {
  const win = { ...info, platform: 'win32', stdio: { command: 'C:\\Program Files\\Cascade\\cascade.exe', args: ['--mcp-stdio'] } }
  expect(mcpSetup('claude', 'global', 'stdio', win).text).toBe('claude mcp add --scope user --transport stdio cascade -- "C:\\Program Files\\Cascade\\cascade.exe" --mcp-stdio')
})
