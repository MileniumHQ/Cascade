import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recoveryKey, type RecoveryMeta } from '../shared/recovery'

const isMeta = (v: unknown): v is RecoveryMeta => {
  const m = v as RecoveryMeta | null
  return !!m && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.savedAt === 'number' && (m.path === undefined || typeof m.path === 'string')
}

async function writeAtomic(file: string, text: string) {
  await writeFile(`${file}.tmp`, text, 'utf8')
  await rename(`${file}.tmp`, file)
}

/** Crash-recovery snapshots: `<id>.cascade` plus a tiny `<id>.json` sidecar with the metadata. */
export function createRecoveryStore(dir: string) {
  const files = (id: string) => ({ project: join(dir, `${recoveryKey(id)}.cascade`), meta: join(dir, `${recoveryKey(id)}.json`) })
  // Writes for one project are serialized so a late snapshot can't land after a discard.
  const queues = new Map<string, Promise<unknown>>()
  const queue = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const key = recoveryKey(id)
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    queues.set(key, next)
    void next.finally(() => queues.get(key) === next && queues.delete(key)).catch(() => {})
    return next
  }
  return {
    write: (meta: RecoveryMeta, text: string) =>
      queue(meta.id, async () => {
        const f = files(meta.id)
        await mkdir(dir, { recursive: true })
        await writeAtomic(f.project, text)
        await writeAtomic(f.meta, JSON.stringify(meta))
      }),
    read: (id: string) =>
      queue(id, async () => {
        try { return await readFile(files(id).project, 'utf8') } catch { return null }
      }),
    discard: (id: string) =>
      queue(id, async () => {
        const f = files(id)
        // Metadata first: a snapshot without a sidecar is invisible.
        await rm(f.meta, { force: true })
        await rm(f.project, { force: true })
        await rm(`${f.meta}.tmp`, { force: true })
        await rm(`${f.project}.tmp`, { force: true })
      }),
    async list(): Promise<RecoveryMeta[]> {
      let names: string[]
      try { names = await readdir(dir) } catch { return [] }
      const out: RecoveryMeta[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const meta: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
          if (isMeta(meta)) out.push(meta)
        } catch { /* unreadable sidecar: ignore */ }
      }
      return out.sort((a, b) => b.savedAt - a.savedAt)
    }
  }
}
