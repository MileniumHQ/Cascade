/** A crash-recovery snapshot of an open project, kept under `<userData>/recovery/<id>.cascade`. */
export interface RecoveryMeta {
  /** Project id (also the snapshot's file name). */
  id: string
  name: string
  /** Where the project lives on disk, if it has a file. */
  path?: string
  /** When the snapshot was written (ms). */
  savedAt: number
}

/** Snapshot ids become file names, so keep them to a safe alphabet. */
export const recoveryKey = (id: string) => id.replace(/[^\w-]+/g, '_').slice(0, 80) || 'project'

/** A snapshot is worth offering when it's newer than the project's file (or there is no file). */
export function isRecoverable(meta: RecoveryMeta, fileMtime: number | null): boolean {
  return fileMtime === null || meta.savedAt > fileMtime
}

/** The newest recoverable snapshot for a project file. */
export function pickRecovery(metas: RecoveryMeta[], path: string, fileMtime: number | null): RecoveryMeta | undefined {
  return metas
    .filter((m) => m.path === path && isRecoverable(m, fileMtime))
    .sort((a, b) => b.savedAt - a.savedAt)[0]
}

/**
 * Debounce with a ceiling: waits `delay` after the last call, but never longer than `maxWait`
 * after the first pending one, so a long drag still writes snapshots.
 */
export function createThrottledTrigger(run: () => void, delay: number, maxWait: number, now: () => number = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let first = 0
  const fire = () => {
    timer = undefined
    first = 0
    run()
  }
  return {
    poke() {
      const t = now()
      if (!first) first = t
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, Math.min(delay, first + maxWait - t)))
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
      first = 0
    }
  }
}
