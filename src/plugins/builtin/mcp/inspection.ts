import type { CascadeAPI } from '@core/app'
import { clipMarkerTimelineTime } from '@core/markers'
import { clipTimeMap } from '@core/time-remap'
import { timelineDuration, type Clip, type Marker, type Timeline, type TransitionInstance } from '@shared/project'
import type { ParamDef } from '@core/plugin-api'
import { clock } from './clock'
import type { Ids } from './edits'

export function projectTimelines(app: CascadeAPI, ids: Ids) {
  const project = app.project()
  return project.timelineOrder.map(id => {
    const tl = project.timelines[id], duration = timelineDuration(tl)
    return { id: ids.show(id, 'l'), name: tl.name, duration: clock(duration), durationFlicks: duration, active: id === project.activeTimeline,
      media: Object.values(project.media).filter(m => m.timelineId === id).map(m => ({ id: ids.show(m.id, 'm'), name: m.name, type: m.type })) }
  })
}
export function markerJson(app: CascadeAPI, ids: Ids, tl: Timeline, marker: Marker, clip?: Clip) {
  const t = clip ? clipMarkerTimelineTime(clip, clipTimeMap(clip, tl, app.registries), marker) : marker.t
  return { id: ids.show(marker.id, 'k'), kind: marker.kind ?? 'marker', name: marker.name, time: t === null ? null : clock(t), t,
    ...(clip ? { clipId: ids.show(clip.id, 'c'), sourceTime: clock(marker.t), sourceFlicks: marker.t, trimmedOut: t === null } : {}),
    ...(marker.duration !== undefined ? { duration: clock(marker.duration), durationFlicks: marker.duration } : {}), color: marker.color, note: marker.note }
}
export function markerText(app: CascadeAPI, ids: Ids, tl: Timeline, marker: Marker, clip?: Clip) {
  const m = markerJson(app, ids, tl, marker, clip)
  return `marker ${m.id} ${m.time ?? 'trimmed out'} ${m.kind} ${JSON.stringify(m.name)}${m.clipId ? ` clip=${m.clipId} source=${m.sourceTime}` : ''}${m.duration ? ` duration=${m.duration}${clip ? ' (source)' : ''}` : ''}${m.color !== undefined ? ` color=${m.color}` : ''}${m.note !== undefined ? ` note=${JSON.stringify(m.note)}` : ''}`
}
export function transitionJson(ids: Ids, tx: TransitionInstance) {
  return { id: ids.show(tx.id, 'x'), type: tx.type, from: tx.from ? ids.show(tx.from, 'c') : undefined, to: tx.to ? ids.show(tx.to, 'c') : undefined,
    duration: clock(tx.duration), durationFlicks: tx.duration, align: tx.align, params: tx.params }
}
export function transitionText(ids: Ids, tx: TransitionInstance) {
  const t = transitionJson(ids, tx)
  return `transition ${t.id} ${t.type}${t.from ? ` from=${t.from}` : ''}${t.to ? ` to=${t.to}` : ''} duration=${t.duration} align=${t.align} params=${JSON.stringify(t.params)}`
}
/** Describe structured values alongside the existing plugin-provided parameter definition. */
export function describeParams(params: ParamDef[]) {
  return params.map(p => ({ ...p, ...(p.type === 'path' ? { valueShape: '{closed:boolean,points:{x:number,y:number,in?:[number,number],out?:[number,number]}[]}; content-box fractions; tangents relative to each point' }
    : p.type === 'curve' ? { valueShape: '{master:[number,number][],r:[number,number][],g:[number,number][],b:[number,number][]}; normalized input/output points (0..1)' } : {}) }))
}
