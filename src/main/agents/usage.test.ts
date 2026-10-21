import { describe, expect, it } from 'vitest'
import { cursorAuthFile, cursorUsage, opencodeUsage, parseClaudeUsage, parseOpencodeStatsText, parseCodexStatus, type ModelCatalog, type OpencodeStats } from './usage'

// Real replies from claude-agent-acp 0.94 `/usage` and codex-acp 2.2 `/status`.
const CLAUDE = `## Usage

> Claude max subscription usage

### Limits

**5-hour limit** — **19%** · Resets Oct 21, 2:59 AM PDT

\`████░░░░░░░░░░░░░░░░\`

**Weekly · all models** — **14%** · Resets Oct 26, 2:59 PM PDT

**Weekly · Fable** — **0%** · Resets Oct 26, 3:00 PM PDT

---

### This session

| Cost | API time | Active |
|:--|:--|:--|
| $0.00 | 0s | 3s |`

const CODEX = `**Model:** gpt-6.1-sol[low]
**Account:** ChatGPT plus (someone@example.com)
**Token usage:** data not available yet
**codex 5h limit:** 100% left (resets 04:34 on Oct 21)
**codex Weekly limit:** 86% left (resets 02:07 on Oct 27)
**codex Credits:** 0`

describe('agent usage', () => {
  it('reads Claude plan limits from /usage', () => {
    const u = parseClaudeUsage(CLAUDE)
    expect(u.meters).toEqual([
      { label: '5-hour limit', percent: 19, resets: 'Oct 21, 2:59 AM PDT' },
      { label: 'Weekly · all models', percent: 14, resets: 'Oct 26, 2:59 PM PDT' },
      { label: 'Weekly · Fable', percent: 0, resets: 'Oct 26, 3:00 PM PDT' }
    ])
    expect(u.stats).toEqual([{ label: 'Plan', value: 'Max' }])
    expect(parseClaudeUsage('## Usage\n\n### This session').note).toMatch(/API-key/)
  })

  it('turns Codex "% left" into % used and drops the email', () => {
    const u = parseCodexStatus(CODEX)
    expect(u.meters).toEqual([
      { label: '5-hour limit', percent: 0, resets: '04:34 on Oct 21' },
      { label: 'Weekly limit', percent: 14, resets: '02:07 on Oct 27' }
    ])
    expect(u.stats).toEqual([{ label: 'Account', value: 'ChatGPT plus' }, { label: 'Credits', value: '0' }])
  })

  it('maps Cursor dashboard usage', () => {
    const u = cursorUsage(
      { billingCycleEnd: '1793031319627', planUsage: { autoPercentUsed: 5.37, apiPercentUsed: 0, totalPercentUsed: 5.37 } },
      { planInfo: { planName: 'Pro', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY', includedUsageResetsAt: '1793031319627' } },
      1792564317050
    )
    expect(u.meters.map(m => [m.label, m.percent])).toEqual([['Weekly · total', 5.37], ['Weekly · Auto', 5.37], ['Weekly · API models', 0]])
    expect(u.meters[0].resets).toBeTruthy()
    expect(u.stats).toEqual([{ label: 'Plan', value: 'Pro' }])
    expect(cursorUsage({}, {}).note).toBeTruthy()
  })

  it('finds cursor-agent’s login per platform', () => {
    expect(cursorAuthFile('/home/u', 'linux', {})).toBe('/home/u/.config/cursor/auth.json')
    expect(cursorAuthFile('/Users/u', 'darwin', {})).toBe('/Users/u/.cursor/auth.json')
    expect(cursorAuthFile('C:\\Users\\u', 'win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toMatch(/Roaming[\\/]Cursor[\\/]auth\.json$/)
  })

  it('totals OpenCode free-model use and prices it at the paid sibling', () => {
    const tokens = (input: number, output: number, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } })
    const catalog: ModelCatalog = {
      opencode: { models: { 'deepseek-flash-free': { cost: { input: 0, output: 0 } }, 'deepseek-flash': { cost: { input: 0.3, output: 1.2, cache_read: 0.006 } }, 'big-pickle': { cost: { input: 0, output: 0 } } } }
    }
    const week: OpencodeStats = {
      prompts: 9, cost: 1.5, tokens: tokens(3_000_000, 500_000),
      models: [
        { model: { id: 'paid-model', providerID: 'vendor' }, steps: 10, tokens: tokens(1_000_000, 100_000), cost: 1.5 },
        { model: { id: 'deepseek-flash-free', providerID: 'opencode' }, steps: 40, tokens: tokens(1_000_000, 100_000, 1_000_000), cost: 0 },
        { model: { id: 'big-pickle', providerID: 'opencode' }, steps: 5, tokens: tokens(10_000, 1_000), cost: 0 },
        { model: { id: 'big-pickle', providerID: 'opencode' }, steps: 1, tokens: tokens(5_000, 0), cost: 0 }
      ]
    }
    const u = opencodeUsage({ prompts: 1, cost: 0, tokens: tokens(0, 0) }, week, catalog)
    expect(u.meters).toEqual([])
    // 1M in × $0.30 + 0.1M out × $1.20 + 1M cache × $0.006 = $0.43; Big Pickle has no paid sibling.
    expect(u.stats.find(s => s.label === 'Free models, 7 days')?.value).toBe('2.1M tokens · 46 requests')
    expect(u.stats.at(-1)).toEqual({ label: 'Saved vs. paid versions', value: '≈$0.43' })
    expect(u.stats.filter(s => s.sub).map(s => [s.label, s.value])).toEqual([['deepseek-flash-free', '2.1M tokens'], ['big-pickle', '16k tokens']])
    // No cached catalog: `-free` ids still count, without a price estimate.
    expect(opencodeUsage(week, week, null).stats.find(s => s.label === 'Free models, 7 days')?.value).toBe('2.1M tokens · 40 requests')
  })
})

describe('OpenCode 1.x stats text', () => {
  // Same layout as `opencode stats --models` 1.19: 55-wide rows, `│ provider/model │` model headers.
  const row = (label: string, value: string) => `│${label}${' '.repeat(Math.max(0, 55 - label.length - value.length))}${value} │`
  const head = (title: string) => `│${title.padStart(31 + title.length / 2).padEnd(56)}│`
  const text = [
    '┌────┐', head('OVERVIEW'), '├────┤', row('Sessions', '3'), row('Messages', '42'), row('Days', '1'), '└────┘', '',
    head('COST & TOKENS'), row('Total Cost', '$1.25'), row('Avg Cost/Day', '$1.25'), row('Avg Tokens/Session', '400.0K'),
    row('Input', '1.2M'), row('Output', '35.5K'), row('Cache Read', '800'), row('Cache Write', '0'), '',
    head('MODEL USAGE'), `│ ${'opencode/big-pickle'.padEnd(54)} │`, row('  Messages', '30'), row('  Input Tokens', '1.0M'), row('  Output Tokens', '20.0K'),
    row('  Cache Read', '0'), row('  Cache Write', '0'), row('  Cost', '$0.0000'),
    `│ ${'anthropic/claude-sonnet-5-5'.padEnd(54)} │`, row('  Messages', '12'), row('  Input Tokens', '200.0K'), row('  Output Tokens', '15.5K'),
    row('  Cache Read', '800'), row('  Cache Write', '0'), row('  Cost', '$1.2500')
  ].join('\n')

  it('reads totals and per-model rows', () => {
    const stats = parseOpencodeStatsText(text)
    expect(stats).toMatchObject({ prompts: 42, cost: 1.25, tokens: { input: 1.2e6, output: 35_500, reasoning: 0, cache: { read: 800, write: 0 } } })
    expect(stats.models).toEqual([
      { model: { providerID: 'opencode', id: 'big-pickle' }, steps: 30, cost: 0, tokens: { input: 1e6, output: 20_000, reasoning: 0, cache: { read: 0, write: 0 } } },
      { model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, steps: 12, cost: 1.25, tokens: { input: 200_000, output: 15_500, reasoning: 0, cache: { read: 800, write: 0 } } }
    ])
    expect(opencodeUsage(stats, stats, null).stats[0].value).toBe('1.2M tokens · $1.25')
  })

  it('treats an empty report as zero', () => {
    expect(parseOpencodeStatsText('')).toMatchObject({ prompts: 0, cost: 0, models: [] })
  })
})
