// Plan usage per agent, for the panel's usage popover. Each agent exposes it differently:
// Claude and Codex answer their own `/usage` / `/status` commands (local, no model call), Cursor has
// the dashboard API its CLI uses, OpenCode keeps per-model stats on disk (`opencode stats`).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentUsage, UsageMeter, UsageStat } from '../../shared/agents'

const percent = (s: string) => Math.max(0, Math.min(100, Number(s)))

/** claude-agent-acp's `/usage` markdown: `**5-hour limit** — **19%** · Resets Oct 21, 2:59 AM PDT`. */
export function parseClaudeUsage(markdown: string): AgentUsage {
  const meters: UsageMeter[] = []
  for (const m of markdown.matchAll(/^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/gm)) {
    meters.push({ label: m[1], percent: percent(m[2]), ...(m[3] ? { resets: m[3].trim() } : {}) })
  }
  const plan = /^> (.+?) usage$/m.exec(markdown)?.[1]
  // "Claude max subscription" → "Max".
  const name = plan?.replace(/^Claude /i, '').replace(/ subscription$/i, '')
  const stats: UsageStat[] = name ? [{ label: 'Plan', value: name.charAt(0).toUpperCase() + name.slice(1) }] : []
  return { meters, stats, ...(meters.length ? {} : { note: 'No plan limits reported. API-key sign-ins are billed per token.' }) }
}

/** codex-acp's `/status` markdown: `**codex 5h limit:** 100% left (resets 04:34 on Oct 21)`. */
export function parseCodexStatus(markdown: string): AgentUsage {
  const meters: UsageMeter[] = []
  for (const m of markdown.matchAll(/^\*\*(?:codex )?(.+? limit):\*\* (\d+(?:\.\d+)?)% left(?: \(resets (.+?)\))?/gim)) {
    meters.push({ label: m[1].replace(/^5h\b/, '5-hour'), percent: 100 - percent(m[2]), ...(m[3] ? { resets: m[3] } : {}) })
  }
  const stats: UsageStat[] = []
  const account = /^\*\*Account:\*\* (.+?)\s*$/m.exec(markdown)?.[1]
  if (account) stats.push({ label: 'Account', value: account.replace(/\s*\(.*\)$/, '') })
  const credits = /^\*\*(?:codex )?Credits:\*\* (.+?)\s*$/im.exec(markdown)?.[1]
  if (credits) stats.push({ label: 'Credits', value: credits })
  return { meters, stats, ...(meters.length ? {} : { note: 'No plan limits reported. API-key sign-ins are billed per token.' }) }
}

// ───────────── Cursor ─────────────

/** Where cursor-agent keeps its login (same rules as the CLI). */
export function cursorAuthFile(home: string, platform = process.platform, env = process.env) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json')
  if (platform === 'darwin') return join(home, '.cursor', 'auth.json')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cursor', 'auth.json')
}

interface CursorPeriod { billingCycleEnd?: string; planUsage?: { totalPercentUsed?: number; autoPercentUsed?: number; apiPercentUsed?: number } }
interface CursorPlan { planInfo?: { planName?: string; includedUsagePeriod?: string; includedUsageResetsAt?: string } }

export function cursorUsage(period: CursorPeriod, plan: CursorPlan, now = Date.now()): AgentUsage {
  const usage = period.planUsage
  const info = plan.planInfo
  const resetsAt = Number(info?.includedUsageResetsAt ?? period.billingCycleEnd)
  const resets = resetsAt > now ? new Date(resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : undefined
  const span = /WEEKLY/.test(info?.includedUsagePeriod ?? '') ? 'Weekly' : /MONTHLY/.test(info?.includedUsagePeriod ?? '') ? 'Monthly' : 'Included'
  const meters: UsageMeter[] = []
  const add = (label: string, value: number | undefined) => { if (typeof value === 'number') meters.push({ label, percent: percent(String(value)), ...(resets ? { resets } : {}) }) }
  add(`${span} · total`, usage?.totalPercentUsed)
  add(`${span} · Auto`, usage?.autoPercentUsed)
  add(`${span} · API models`, usage?.apiPercentUsed)
  return {
    meters,
    stats: info?.planName ? [{ label: 'Plan', value: info.planName }] : [],
    ...(usage ? {} : { note: 'Cursor doesn’t report usage for this plan.' })
  }
}

const CURSOR_API = 'https://api2.cursor.sh/aiserver.v1.DashboardService'
/** Uses cursor-agent's own login; it refreshes the token whenever it runs. */
export async function fetchCursorUsage(home: string, fetcher: typeof fetch = fetch): Promise<AgentUsage> {
  let token: string | undefined
  try { token = (JSON.parse(await readFile(cursorAuthFile(home), 'utf8')) as { accessToken?: string }).accessToken } catch { /* Not signed in. */ }
  if (!token) throw new Error('Sign in to Cursor (start a Cursor chat) to see usage.')
  const call = async <T>(method: string): Promise<T> => {
    const response = await fetcher(`${CURSOR_API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: '{}',
      signal: AbortSignal.timeout(15_000)
    })
    if (response.status === 401) throw new Error('Cursor sign-in expired. Send a message in a Cursor chat to refresh it.')
    if (!response.ok) throw new Error(`Cursor usage request failed (${response.status}).`)
    return await response.json() as T
  }
  const [period, plan] = await Promise.all([call<CursorPeriod>('GetCurrentPeriodUsage'), call<CursorPlan>('GetPlanInfo').catch(() => ({}))])
  return cursorUsage(period, plan)
}

// ───────────── OpenCode ─────────────

interface Tokens { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export interface OpencodeStats { prompts: number; tokens: Tokens; cost: number; models?: { model: { id: string; providerID: string }; steps: number; tokens: Tokens; cost: number }[] }
/** models.dev catalog as cached by OpenCode: provider → models → $/1M tokens. */
export type ModelCatalog = Record<string, { name?: string; models?: Record<string, { cost?: { input?: number; output?: number; cache_read?: number } }> }>

const total = (t: Tokens) => t.input + t.output + t.reasoning + t.cache.read + t.cache.write
export const compact = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
const dollars = (n: number) => n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`

/** Free = priced at zero in the catalog (Zen's `*-free` models, Big Pickle); without a catalog, the `-free` suffix. */
function isFree(provider: string, id: string, cost: number, catalog: ModelCatalog | null) {
  if (cost > 0) return false
  const price = catalog?.[provider]?.models?.[id]?.cost
  return price ? !price.input && !price.output : /-free$/.test(id)
}
/** What the same tokens cost on the paid version of a free model (`x-free` → `x`), when the catalog lists one. */
function paidEquivalent(provider: string, id: string, tokens: Tokens, catalog: ModelCatalog | null) {
  const base = id.replace(/-free$/, '')
  if (!catalog || base === id) return undefined
  for (const p of [provider, 'opencode', 'opencode-go']) {
    const price = catalog[p]?.models?.[base]?.cost
    if (price && (price.input || price.output)) return (tokens.input * (price.input ?? 0) + (tokens.output + tokens.reasoning) * (price.output ?? 0) + tokens.cache.read * (price.cache_read ?? price.input ?? 0)) / 1e6
  }
  return undefined
}

export function opencodeUsage(today: OpencodeStats, week: OpencodeStats, catalog: ModelCatalog | null): AgentUsage {
  const stats: UsageStat[] = [
    { label: 'Today', value: `${compact(total(today.tokens))} tokens · ${dollars(today.cost)}` },
    { label: 'Last 7 days', value: `${compact(total(week.tokens))} tokens · ${dollars(week.cost)}` }
  ]
  const free = (week.models ?? []).filter(m => isFree(m.model.providerID, m.model.id, m.cost, catalog))
  if (free.length) {
    const tokens = free.reduce((sum, m) => sum + total(m.tokens), 0)
    const steps = free.reduce((sum, m) => sum + m.steps, 0)
    const worth = free.reduce((sum, m) => sum + (paidEquivalent(m.model.providerID, m.model.id, m.tokens, catalog) ?? 0), 0)
    stats.push({ label: 'Free models, 7 days', value: `${compact(tokens)} tokens · ${steps} requests` })
    // Stats list a model once per reasoning variant; the breakdown is per model.
    const byModel = new Map<string, number>()
    for (const m of free) byModel.set(m.model.id, (byModel.get(m.model.id) ?? 0) + total(m.tokens))
    for (const [id, n] of [...byModel].sort((a, b) => b[1] - a[1]).slice(0, 3)) stats.push({ label: id, value: `${compact(n)} tokens`, sub: true })
    if (worth >= 0.01) stats.push({ label: 'Saved vs. paid versions', value: `≈${dollars(worth)}` })
  }
  return { meters: [], stats, note: 'All OpenCode use on this computer. Free models have no published quota.' }
}

/** OpenCode 1.x has no `stats --json`: read its boxed text report (tokens abbreviated as 1.2K / 3.4M). */
export function parseOpencodeStatsText(text: string): OpencodeStats {
  const num = (v = '') => { const m = /([\d.,]+)\s*([KM]?)/.exec(v); return m ? Number(m[1].replace(/,/g, '')) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : 0 }
  const empty = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  const stats: OpencodeStats = { prompts: 0, tokens: empty(), cost: 0, models: [] }
  let section = '', model: NonNullable<OpencodeStats['models']>[number] | null = null
  for (const line of text.split('\n')) {
    const cell = /^│(.*)│\s*$/.exec(line)?.[1]
    if (!cell) continue
    if (/^\s{4,}[A-Z &]+\s*$/.test(cell)) { section = cell.trim(); continue }
    const row = /^(\s*)(\S.*?)\s{2,}(\S.*?)\s*$/.exec(cell)
    if (section === 'MODEL USAGE') {
      if (!row) {
        const [providerID, ...id] = cell.trim().split('/')
        model = { model: { providerID: id.length ? providerID : '', id: id.length ? id.join('/') : providerID }, steps: 0, tokens: empty(), cost: 0 }
        stats.models!.push(model)
        continue
      }
      if (!model) continue
      const [, , label, value] = row
      if (label === 'Messages') model.steps = num(value)
      else if (label === 'Input Tokens') model.tokens.input = num(value)
      else if (label === 'Output Tokens') model.tokens.output = num(value)
      else if (label === 'Cache Read') model.tokens.cache.read = num(value)
      else if (label === 'Cache Write') model.tokens.cache.write = num(value)
      else if (label === 'Cost') model.cost = num(value)
      continue
    }
    if (!row) continue
    const [, , label, value] = row
    if (label === 'Messages') stats.prompts = num(value)
    else if (label === 'Total Cost') stats.cost = num(value)
    else if (label === 'Input') stats.tokens.input = num(value)
    else if (label === 'Output') stats.tokens.output = num(value)
    else if (label === 'Cache Read') stats.tokens.cache.read = num(value)
    else if (label === 'Cache Write') stats.tokens.cache.write = num(value)
  }
  return stats
}

/** OpenCode caches the models.dev catalog (with prices) under the XDG cache dir on every platform. */
export async function readModelCatalog(home: string, env = process.env): Promise<ModelCatalog | null> {
  try { return JSON.parse(await readFile(join(env.XDG_CACHE_HOME || join(home, '.cache'), 'opencode', 'models.json'), 'utf8')) as ModelCatalog } catch { return null }
}
