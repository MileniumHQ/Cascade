import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One flag per path, checked in parallel. */
export async function existsMany(paths: string[]): Promise<boolean[]> {
  return Promise.all(paths.map((p) => (typeof p === 'string' ? access(p).then(() => true, () => false) : false)))
}

/**
 * Breadth-first search under `dir` for files with the given names (case-insensitive fallback),
 * so the closest match wins. Bounded in depth and entries; hidden folders and node_modules are skipped.
 */
export async function findByName(dir: string, names: string[], limits = { depth: 8, entries: 60_000 }): Promise<Record<string, string>> {
  const wanted = new Map<string, string>()
  for (const n of names) wanted.set(n, n)
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]))
  const out: Record<string, string> = {}
  let seen = 0
  let level = [dir]
  for (let depth = 0; level.length && depth <= limits.depth && Object.keys(out).length < names.length; depth++) {
    const next: string[] = []
    for (const d of level) {
      let entries
      try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (++seen > limits.entries) return out
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && e.name !== 'node_modules') next.push(join(d, e.name))
          continue
        }
        const exact = wanted.has(e.name) ? e.name : undefined
        const key = exact ?? lower.get(e.name.toLowerCase())
        if (key && !out[key]) out[key] = join(d, e.name)
      }
    }
    level = next
  }
  return out
}
