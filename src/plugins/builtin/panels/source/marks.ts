import type { Id, Project } from '@shared/project'
import type { Flicks } from '@shared/time'

/** In/out marks on a source item, as offsets into the media. Either may be absent. */
export interface SourceMarks {
  in?: Flicks
  out?: Flicks
}

export const SOURCE_DATA_ID = 'cascade.source'

interface SourceData {
  marks?: Record<Id, SourceMarks>
}

const clampTo = (t: Flicks, length: Flicks | undefined) => Math.max(0, length === undefined ? t : Math.min(t, length))

/** Mark in at `t`. A later out stays; an out at or before the new in is dropped. */
export function markIn(m: SourceMarks, t: Flicks, length?: Flicks): SourceMarks {
  const at = clampTo(t, length)
  return m.out !== undefined && m.out <= at ? { in: at } : { ...m, in: at }
}

/** Mark out at `t`. An earlier in stays; an in at or after the new out is dropped. */
export function markOut(m: SourceMarks, t: Flicks, length?: Flicks): SourceMarks {
  const at = clampTo(t, length)
  return m.in !== undefined && m.in >= at ? { out: at } : { ...m, out: at }
}

export const isEmpty = (m: SourceMarks) => m.in === undefined && m.out === undefined

/** The range the marks select within a source of `length`: unset ends mean the media's edges. */
export function markedRange(m: SourceMarks, length: Flicks): { start: Flicks; end: Flicks } {
  const start = clampTo(m.in ?? 0, length)
  const end = m.out !== undefined && m.out > start ? clampTo(m.out, length) : length
  return { start, end }
}

/** Marks stored in the project for a media item (empty when none). */
export function marksOf(project: Project, mediaId: Id): SourceMarks {
  return (project.pluginData[SOURCE_DATA_ID] as SourceData | undefined)?.marks?.[mediaId] ?? {}
}

/** Write marks into a project draft; empty marks remove the entry. */
export function writeMarks(pluginData: Record<string, unknown>, mediaId: Id, m: SourceMarks) {
  const data = (pluginData[SOURCE_DATA_ID] ??= {}) as SourceData
  if (isEmpty(m)) {
    if (data.marks) delete data.marks[mediaId]
    return
  }
  ;(data.marks ??= {})[mediaId] = m
}
