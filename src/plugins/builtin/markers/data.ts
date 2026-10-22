import type { Marker } from '@shared/project'
import { FLICKS, type Flicks } from '@shared/time'
export interface MarkerEntry { marker: Marker; t: Flicks; clipId?: string; clipName?: string }
export const markerColor = (marker: Marker, kindColor?: string) => marker.color ?? kindColor ?? '#ffffff'
export function markerCsv(entries: MarkerEntry[]): string {
  const field = (value: unknown) => `"${String(value ?? '').replaceAll('"','""')}"`
  return [['Time (seconds)','Duration (flicks)','Color','Name','Kind','Note','Clip'], ...entries.map(({marker:m,t,clipName}) => [t/FLICKS,m.duration ?? 0,m.color ?? '',m.name,m.kind ?? 'marker',m.note ?? '',clipName ?? ''])].map(row=>row.map(field).join(',')).join('\r\n')
}
export function chapterText(entries: MarkerEntry[]): string {
  const chapters = entries.some(e => e.marker.kind === 'chapter') ? entries.filter(e=>e.marker.kind==='chapter') : entries
  const sorted = [...chapters].sort((a,b)=>a.t-b.t)
  if (!sorted.length) return ''
  const seconds = new Map<number,string>()
  for (const e of sorted) if (!seconds.has(Math.floor(e.t/FLICKS))) seconds.set(Math.floor(e.t/FLICKS),e.marker.name.replace(/[\r\n]+/g,' ') || 'Chapter')
  if (!seconds.has(0)) seconds.set(0,sorted[0].marker.name.replace(/[\r\n]+/g,' ') || 'Chapter')
  return [...seconds].sort(([a],[b])=>a-b).map(([s,name])=> {
    const h=Math.floor(s/3600),m=Math.floor(s/60)%60,sec=s%60
    return `${h ? `${h}:${String(m).padStart(2,'0')}` : String(m)}:${String(sec).padStart(2,'0')} ${name}`
  }).join('\n')
}
export interface MarkerClipboardData { markers: Marker[] }
export function isMarkerData(data: unknown): data is MarkerClipboardData {
  if (!data || typeof data !== 'object' || !('markers' in data) || !Array.isArray(data.markers) || !data.markers.length) return false
  return data.markers.every(m=> m && typeof m==='object' && typeof m.id==='string' && typeof m.name==='string' && Number.isSafeInteger(m.t) && m.t>=0 && (m.duration===undefined || Number.isSafeInteger(m.duration) && m.duration>=0) && ['kind','color','note'].every(k=>m[k]===undefined || typeof m[k]==='string'))
}
/** Copy positions as relative timeline times; pasted markers become timeline annotations. */
export function captureMarkers(entries: MarkerEntry[], ids: string[]): MarkerClipboardData | null {
  const selected=entries.filter(e=>ids.includes(e.marker.id))
  if (!selected.length) return null
  const origin=Math.min(...selected.map(e=>e.t))
  return {markers:selected.map(e=>({...structuredClone(e.marker),t:e.t-origin}))}
}
