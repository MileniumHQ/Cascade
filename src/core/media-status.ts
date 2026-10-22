import type { Id, Project } from '@shared/project'
import type { HostBridge } from '@shared/ipc'
import { Value } from './value'

const sameSet = (a: ReadonlySet<Id>, b: ReadonlySet<Id>) => a.size === b.size && [...a].every((id) => b.has(id))

/**
 * Runtime health of file-backed media. "Offline" (the file is gone) is never stored in the
 * document: it's re-checked when a project opens, when the window regains focus and when the
 * media list changes. Any panel or plugin can read `offline` / `isOffline`.
 */
export class MediaStatusService {
  /** Ids of media whose file is missing. */
  readonly offline = new Value<ReadonlySet<Id>>(new Set(), sameSet)
  private token = 0

  constructor(
    private host: HostBridge | null,
    private project: () => Project
  ) {}

  isOffline(id: Id | undefined): boolean {
    return !!id && this.offline.get().has(id)
  }

  /** Check every file-backed item with one batched call. */
  async check(): Promise<void> {
    const host = this.host
    if (!host) return
    const mine = ++this.token
    const items = Object.values(this.project().media).filter((m) => m.path)
    let flags: boolean[]
    try {
      flags = items.length ? await host.fs.existsMany(items.map((m) => m.path!)) : []
    } catch {
      return
    }
    if (mine !== this.token) return
    this.offline.set(new Set(items.filter((_m, i) => !flags[i]).map((m) => m.id)))
  }
}
