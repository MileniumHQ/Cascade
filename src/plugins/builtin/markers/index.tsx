import { definePlugin, type CommandContribution } from '@core/plugin-api'
import { clipEnd, findClip } from '@shared/project'
import { frameDuration } from '@shared/time'
import { solidMount } from '../solid'
import { chapterText, markerCsv } from './data'
import { closeMarkerEditors, MarkersPanel, openMarkerEditor } from './ui'
import { registerMarkerClipboard, timelineMarkerEntries as entries } from './clipboard'
export const markersPlugin = definePlugin({
  id:'builtin.markers',name:'Markers',
  activate(ctx) {
    for (const [id,name,color] of [['marker','Marker','#ffffff'],['chapter','Chapter','#82cbff'],['todo','To do','#f2c14e']]) ctx.markerKinds.register({id,name,color,icon:'bookmark'})
    ctx.settings.register({id:'timeline.rippleMarkers',label:'Ripple markers',description:'Shift timeline markers when inserting or removing time.',section:'Timeline',type:'toggle',default:true})
    ctx.panels.register({id:'markers',title:'Markers',icon:'bookmark',region:'bottom',order:4,mount:solidMount(MarkersPanel)})
    ctx.track({dispose:()=>closeMarkerEditors(ctx.app)})
    const copyText=async(app:typeof ctx.app,text:string)=>{
      try {await navigator.clipboard.writeText(text);app.notify('success','Copied to clipboard')}
      catch {app.notify('warning','System clipboard unavailable')}
    }
    const commands:CommandContribution[]=[
      {id:'markers.add',title:'Add marker',icon:'bookmark',run:a=>{
        const t=a.playback.time.get(),existing=entries(a).find(e=>e.t===t)
        if(existing){a.selection.setMarkers([existing.marker.id]);a.run('markers.edit',existing.marker.id);return existing.marker.id}
        const id=a.edit.addMarker(t,'Marker',{kind:'marker'});if(id)a.selection.setMarkers([id]);return id
      }},
      {id:'markers.edit',title:'Edit marker…',run:(a,id,anchor)=>openMarkerEditor(a,id ?? a.selection.markers.get()[0],anchor)},
      {id:'markers.setColor',title:'Set marker color',run:(a,id,color)=>a.edit.updateMarker(id,{color})},
      {id:'markers.delete',title:'Delete markers',icon:'trash-2',enabled:a=>a.selection.markers.get().length>0,run:a=>a.edit.removeMarkers(a.selection.markers.get())},
      {id:'markers.next',title:'Next marker',run:a=>{const e=entries(a).find(e=>e.t>a.playback.time.get());if(e){a.playback.seek(e.t);a.selection.setMarkers([e.marker.id])}}},
      {id:'markers.prev',title:'Previous marker',run:a=>{const e=entries(a).filter(e=>e.t<a.playback.time.get()).at(-1);if(e){a.playback.seek(e.t);a.selection.setMarkers([e.marker.id])}}},
      {id:'markers.addClipMarker',title:'Add clip marker',icon:'bookmark',run:(a,id)=>{
        const f=findClip(a.timeline(),typeof id==='string'?id:a.selection.primaryClip ?? '')
        if (!f || f.track.locked) return
        const t=Math.max(f.clip.start,Math.min(clipEnd(f.clip)-frameDuration(a.fps()),a.playback.time.get()))
        const marker=a.edit.addMarker(t,'Marker',{clipId:f.clip.id,kind:'marker'});if(marker)a.selection.setMarkers([marker]);return marker
      }},
      {id:'markers.exportCsv',title:'Copy markers as CSV',run:a=>copyText(a,markerCsv(entries(a)))},
      {id:'markers.copyChapters',title:'Copy YouTube chapters',run:a=>copyText(a,chapterText(entries(a)))},
      {id:'markers.open',title:'Markers',icon:'bookmark',run:a=>a.layout.activeBottom.set('markers')}
    ]
    for(const command of commands)ctx.commands.register({category:'Markers',...command})
    for(const [key,command] of [['M','markers.add'],['Shift+M','markers.next'],['Mod+Shift+M','markers.prev']])ctx.keybindings.register({id:`${command}:key`,key,command})
    for(const [i,id] of ['markers.add','markers.addClipMarker','markers.next','markers.prev','markers.edit','markers.delete','markers.exportCsv','markers.copyChapters'].entries())ctx.menus.register({id:`menu:${id}`,location:'app/timeline',group:'markers',order:80+i,command:id,label:commands.find(c=>c.id===id)!.title})
    ctx.menus.register({id:'clip:addMarker',location:'clip/context',group:'markers',command:'markers.addClipMarker',label:'Add clip marker',icon:'bookmark',when:(a,id)=>!findClip(a.timeline(),String(id))?.track.locked})
    ctx.menus.register({id:'view:markers',location:'app/view',group:'panels',command:'markers.open',label:'Markers',order:31})
    registerMarkerClipboard(ctx)
  }
})
