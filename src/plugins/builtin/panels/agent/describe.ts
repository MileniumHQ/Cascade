// Human labels for agent work rows and model names. Agents differ wildly here: Claude Code titles MCP calls
// `mcp__cascade__timeline_get`, OpenCode runs every MCP call through one `execute` tool whose input is code
// (`tools.cascade.timeline_get({…})`), shells title calls with the command or just "shell".

export interface ToolLabel { label: string; cascade: boolean; mono?: boolean }
interface ToolInfo { title?: string | null; kind?: string | null; rawInput?: unknown; locations?: { path: string }[] | null }

const pretty = (name: string) => name.replace(/_/g, ' ')
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** `tools.cascade.timeline_get(...)` / `tools["cascade"]["frame_get"](...)` inside code-mode input. */
export function cascadeCalls(code: string): string[] {
  const names = [...code.matchAll(/tools\s*(?:\.\s*cascade|\[\s*["'`]cascade["'`]\s*\])\s*(?:\.\s*(\w+)|\[\s*["'`](\w+)["'`]\s*\])/g)].map(m => m[1] ?? m[2])
  return [...new Set(names)]
}

export function describeTool(t: ToolInfo): ToolLabel {
  const title = t.title ?? ''
  const input = (t.rawInput && typeof t.rawInput === 'object' ? t.rawInput : {}) as Record<string, unknown>
  const named = title.match(/(?:mcp__)?cascade(?:__|\.|: ?|\/)(\w+)/i)
  if (named) return { label: pretty(named[1]), cascade: true }
  if (typeof input.code === 'string') {
    const calls = cascadeCalls(input.code)
    return calls.length ? { label: calls.map(pretty).join(', '), cascade: true } : { label: 'Ran code', cascade: false }
  }
  const command = input.command ?? input.cmd
  if (t.kind === 'execute' || typeof command === 'string') {
    const line = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' ') : ''
    if (line) return { label: line.split('\n')[0], cascade: false, mono: true }
  }
  const path = t.locations?.[0]?.path ?? [input.path, input.file_path, input.filePath].find((p): p is string => typeof p === 'string')
  const generic = !title || /^(read|edit|write|shell|bash|execute|search|grep|glob|fetch)$/i.test(title)
  if (generic && path && t.kind !== 'execute') {
    const verb = t.kind === 'edit' ? 'Edit' : t.kind === 'delete' ? 'Delete' : 'Read'
    return { label: `${verb} ${base(path)}`, cascade: false }
  }
  const pattern = input.pattern ?? input.query
  if (generic && typeof pattern === 'string') return { label: `Search ${pattern}`, cascade: false }
  return { label: title || 'Tool', cascade: false }
}

/** First line of a thought, markdown stripped, for the collapsed row. */
export const thoughtPreview = (text: string) => text.replace(/[*_`#>]/g, '').trim().split(/\n/)[0].slice(0, 140)

const PROVIDERS: Record<string, string> = {
  opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go', 'google-vertex': 'Google Vertex', google: 'Google', openai: 'OpenAI',
  anthropic: 'Anthropic', openrouter: 'OpenRouter', 'github-copilot': 'GitHub Copilot', xai: 'xAI', deepseek: 'DeepSeek',
  groq: 'Groq', mistral: 'Mistral', ollama: 'Ollama', lmstudio: 'LM Studio', azure: 'Azure', 'amazon-bedrock': 'Amazon Bedrock'
}
const providerName = (slug: string) => PROVIDERS[slug.toLowerCase()] ?? slug.split(/[-_]/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')

/** "google-vertex/Claude Opus 5.5" → { name: "Claude Opus 5.5", provider: "Google Vertex" }. */
export function modelParts(name: string): { name: string; provider?: string } {
  const m = name.match(/^([\w.-]+)\/(.+)$/)
  return m ? { name: m[2].trim(), provider: providerName(m[1]) } : { name }
}
