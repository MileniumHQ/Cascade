import type { HostInfo } from '@shared/ipc'

/** Copy-pastable MCP client configurations for connecting agents to this editor. */
export type McpClient = 'claude' | 'codex' | 'cursor' | 'opencode' | 'vscode' | 'json'
export type McpScope = 'project' | 'global'
export type McpTransport = 'http' | 'stdio'

export const MCP_CLIENTS: { value: McpClient; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'json', label: 'Other' }
]

export interface McpSetup {
  /** Where it goes: a shell, or a config file path. */
  target: string
  kind: 'shell' | 'json' | 'toml'
  text: string
  note?: string
}

type Info = HostInfo['mcp'] & { platform: string }

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
/** Double quotes read the same in cmd.exe and PowerShell (Windows paths have no `"`, `$` or backtick). */
const winQuote = (s: string) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s}"`)
const tomlString = (s: string) => JSON.stringify(s)

/** The stdio proxy as one command line, clearing ELECTRON_RUN_AS_NODE (it turns Electron into plain Node). */
export function stdioCommand(info: Info): string[] {
  const s = info.stdio!
  const env = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`)
  if (info.platform === 'win32') return [s.command, ...s.args]
  return ['env', '-u', 'ELECTRON_RUN_AS_NODE', ...env, s.command, ...s.args]
}

export function mcpSetup(client: McpClient, scope: McpScope, transport: McpTransport, info: Info): McpSetup {
  const headers = { Authorization: `Bearer ${info.token ?? ''}` }
  const [command, ...args] = transport === 'stdio' && info.stdio ? stdioCommand(info) : []
  const stdio = transport === 'stdio' && !!info.stdio
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  const project = scope === 'project'
  switch (client) {
    case 'claude': {
      const cmd = stdio
        ? `claude mcp add --scope ${project ? 'project' : 'user'} --transport stdio cascade -- ${[command, ...args].map(info.platform === 'win32' ? winQuote : shellQuote).join(' ')}`
        : `claude mcp add --scope ${project ? 'project' : 'user'} --transport http cascade ${info.url} --header "Authorization: Bearer ${info.token ?? ''}"`
      return { target: project ? 'Run in the project folder → .mcp.json' : 'Run in a terminal → ~/.claude.json', kind: 'shell', text: cmd }
    }
    case 'codex': {
      const body = stdio
        ? `command = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]`
        : `url = ${tomlString(info.url)}\nhttp_headers = { "Authorization" = ${tomlString(headers.Authorization)} }`
      return {
        target: project ? '.codex/config.toml' : '~/.codex/config.toml',
        kind: 'toml',
        text: `[mcp_servers.cascade]\n${body}\n`,
        note: project ? 'Codex reads project config only in trusted projects.' : undefined
      }
    }
    case 'cursor':
      return { target: project ? '.cursor/mcp.json' : '~/.cursor/mcp.json', kind: 'json', text: json({ mcpServers: { cascade: stdio ? { command, args } : { url: info.url, headers } } }) }
    case 'opencode':
      return {
        target: project ? 'opencode.json' : '~/.config/opencode/opencode.json',
        kind: 'json',
        text: json({ $schema: 'https://opencode.ai/config.json', mcp: { cascade: stdio ? { type: 'local', command: [command, ...args], enabled: true } : { type: 'remote', url: info.url, headers, enabled: true } } })
      }
    case 'vscode':
      return {
        target: project ? '.vscode/mcp.json' : 'User mcp.json (Command Palette → MCP: Open User Configuration)',
        kind: 'json',
        text: json({ servers: { cascade: stdio ? { type: 'stdio', command, args } : { type: 'http', url: info.url, headers } } })
      }
    case 'json':
      return {
        target: project ? 'Your client’s project MCP config' : 'Your client’s global MCP config',
        kind: 'json',
        text: json({ mcpServers: { cascade: stdio ? { command, args } : { type: 'http', url: info.url, headers } } })
      }
  }
}
