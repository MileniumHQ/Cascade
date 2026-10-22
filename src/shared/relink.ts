/** Path matching for relinking missing media: infer "the folder moved" from one relinked file. */

export const splitPath = (p: string) => p.split(/[\\/]/)

/** `from` → `to` directory move, as path components. */
export interface PathRoots {
  from: string[]
  to: string[]
  sep: string
}

const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
const windowsLike = (parts: string[]) => /^[a-zA-Z]:$/.test(parts[0] ?? '')

/**
 * Compare how a file moved: strip the trailing components both paths share (`/a/proj/clips/x.mp4` →
 * `/b/proj/clips/x.mp4` is the move `/a` → `/b`). A renamed file moves just its directory.
 */
export function deriveRoots(oldPath: string, newPath: string): PathRoots | null {
  const a = splitPath(oldPath)
  const b = splitPath(newPath)
  if (oldPath === newPath || !a.length || !b.length) return null
  const eq = (x: string, y: string) => (windowsLike(a) || windowsLike(b) ? x.toLowerCase() === y.toLowerCase() : x === y)
  let n = 0
  if (eq(a[a.length - 1], b[b.length - 1])) {
    while (n < a.length && n < b.length && eq(a[a.length - 1 - n], b[b.length - 1 - n])) n++
  } else {
    n = 0
  }
  // A rename keeps only the directory move (drop the file name from both).
  const trim = n === 0 ? 1 : n
  const from = a.slice(0, Math.max(0, a.length - trim))
  const to = b.slice(0, Math.max(0, b.length - trim))
  if (from.length === to.length && from.every((part, i) => eq(part, to[i]))) return null
  return { from, to, sep: sepOf(newPath) }
}

/** Where `path` would be after the move, or null when it isn't under the moved folder. */
export function remapPath(path: string, roots: PathRoots): string | null {
  const parts = splitPath(path)
  const ci = windowsLike(parts)
  const under = roots.from.every((part, i) => (ci ? part.toLowerCase() === (parts[i] ?? '').toLowerCase() : part === parts[i]))
  if (!under || parts.length <= roots.from.length) return null
  return [...roots.to, ...parts.slice(roots.from.length)].join(roots.sep)
}

export const baseName = (p: string) => splitPath(p).pop() ?? p
export const dirName = (p: string) => {
  const parts = splitPath(p)
  parts.pop()
  return parts.join(sepOf(p)) || sepOf(p)
}

export interface OfflineFile {
  id: string
  path: string
}

export interface RelinkIO {
  /** One flag per path. */
  exists(paths: string[]): Promise<boolean[]>
  /** First match (by file name) for each name under `dir`; names without a match are absent. */
  findByName(dir: string, names: string[]): Promise<Record<string, string>>
}

/**
 * After one file was relinked (`anchor`), find the others: first the same relative move, then a
 * search of `searchDir` by file name. Returns the matches only.
 */
export async function findRelinks(offline: OfflineFile[], anchor: { oldPath: string; newPath: string }, searchDir: string, io: RelinkIO): Promise<OfflineFile[]> {
  const found: OfflineFile[] = []
  const rest: OfflineFile[] = []
  const roots = deriveRoots(anchor.oldPath, anchor.newPath)
  const guesses = offline.map((f) => (roots ? remapPath(f.path, roots) : null))
  const toCheck = guesses.filter((g): g is string => !!g)
  const flags = toCheck.length ? await io.exists(toCheck) : []
  let k = 0
  offline.forEach((f, i) => {
    const g = guesses[i]
    if (g && flags[k++]) found.push({ id: f.id, path: g })
    else rest.push(f)
  })
  if (rest.length) found.push(...(await searchFolder(rest, searchDir, io)))
  return found
}

/** Match offline files to files under `dir` by name. */
export async function searchFolder(files: OfflineFile[], dir: string, io: RelinkIO): Promise<OfflineFile[]> {
  if (!files.length) return []
  const hits = await io.findByName(dir, [...new Set(files.map((f) => baseName(f.path)))])
  const out: OfflineFile[] = []
  for (const f of files) {
    const hit = hits[baseName(f.path)]
    if (hit) out.push({ id: f.id, path: hit })
  }
  return out
}
