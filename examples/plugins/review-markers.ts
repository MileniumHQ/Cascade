/** Drop into the user plugin folder to add a marker kind and a specialized clipboard format. */
import type { PluginDefinition } from '../../src/core/plugin-api'
interface ReviewData { reviewNotes: { name: string; note: string }[] }
const valid = (data: unknown): data is ReviewData => !!data && typeof data === 'object' && 'reviewNotes' in data && Array.isArray(data.reviewNotes) && data.reviewNotes.length > 0 && data.reviewNotes.every(n => n && typeof n.name === 'string' && typeof n.note === 'string')
const plugin: PluginDefinition = {
  id:'example.review-markers',name:'Review markers',
  activate(ctx) {
    ctx.markerKinds.register({id:'example.review',name:'Review',icon:'bookmark',color:'#bda3f5'})
    const selected = () => {
      const tl=ctx.app.timeline(),ids=new Set(ctx.app.selection.markers.get())
      return [...tl.markers,...tl.tracks.flatMap(tr=>tr.clips.flatMap(c=>c.markers ?? []))].filter(m=>ids.has(m.id) && m.kind==='example.review')
    }
    ctx.clipboardFormats.register({
      id:'example.review-notes',priority:1100,
      canCopy:()=>selected().length>0,
      copy:()=>({reviewNotes:selected().map(m=>({name:m.name,note:m.note ?? ''}))}),
      canPaste:(_app,data)=>valid(data),
      paste:(app,data)=>{
        if(!valid(data))return
        const ids:string[]=[]
        app.doc.transact('Paste review notes',draft=>{
          for(const note of data.reviewNotes){
            const id=`mk_${crypto.randomUUID()}`;ids.push(id)
            draft.timelines[draft.activeTimeline].markers.push({id,t:app.playback.time.get(),name:note.name,note:note.note,kind:'example.review'})
          }
        })
        app.selection.setMarkers(ids);return ids
      }
    })
  }
}
export default plugin
