import type { CascadeAPI } from '@core/app'
import type { PluginContext } from '@core/plugin-api'
import { visibleMarkers } from '@core/markers'
import { uid } from '@shared/project'
import { captureMarkers, isMarkerData } from './data'
export const timelineMarkerEntries = (app: CascadeAPI) => visibleMarkers(app.timeline(),c=>app.edit.timeMap(c)).map(e=>({marker:e.marker,t:e.t,clipId:e.clip?.id,clipName:e.clip?.name}))
export function registerMarkerClipboard(ctx: PluginContext) {
    ctx.clipboardFormats.register({
      id:'markers',priority:200,canCopy:a=>a.selection.markers.get().length>0,
      copy:a=>captureMarkers(timelineMarkerEntries(a),a.selection.markers.get()),
      canPaste:(_a,data)=>isMarkerData(data),
      paste:(a,data)=>{
        if(!isMarkerData(data))return
        const at=a.playback.time.get(),markers=data.markers.map(m=>({...structuredClone(m),id:uid('mk_'),t:at+m.t}))
        a.doc.transact('Paste markers',d=>{d.timelines[d.activeTimeline].markers.push(...markers)})
        const ids=markers.map(m=>m.id);a.selection.setMarkers(ids);return ids
      },
      remove:(a,data)=>{if(isMarkerData(data))a.edit.removeMarkers(data.markers.map(m=>m.id))}
    })
}
