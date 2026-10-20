import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

export async function loadToken(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'mcp-token')
  try { await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await chmod(path, 0o600)
  const token = (await readFile(path, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid mcp-token file; remove it to regenerate credentials')
  return token
}
export function rejection(req: IncomingMessage, token: string): 401 | 403 | null {
  // Compare the raw authority: URL parsing alone normalizes deceptive spellings.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host ?? '')) return 403
  if (req.headers.origin !== undefined) {
    try {
      const u = new URL(req.headers.origin)
      if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.origin !== req.headers.origin) return 403
    } catch { return 403 }
  }
  const actual = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? null : 401
}
