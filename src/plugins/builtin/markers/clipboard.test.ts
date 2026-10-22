import { expect, it } from 'vitest'
import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import { clipboardPlugin } from '../clipboard'
import { registerMarkerClipboard } from './clipboard'
import { createProject, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
it('prioritizes marker selection and round trips timeline/source markers with metadata in one undo step',async()=>{
  const p=createProject(''),tl=p.timelines[p.activeTimeline]
  tl.markers=[{id:'mk_t',t:S,name:'Timeline',kind:'unknown',note:'note',data:{x:1}}]
  const c:Clip={id:'c',type:'unknown',name:'Clip',start:2*S,duration:4*S,sourceIn:10*S,speed:2,properties:[],data:{},markers:[{id:'mk_c',t:12*S,name:'Source',color:'#82cbff'}]}
  tl.tracks[0].clips=[c]
  const a=new CascadeApp('editor',null,p), host=new PluginHost(a)
  await host.activate(clipboardPlugin,true)
  await host.activate({id:'test.markers',name:'Markers',activate:registerMarkerClipboard},true)
  a.selection.setMarkers(['mk_t','mk_c']);await a.clipboard.copy()
  expect(await a.clipboard.read()).toMatchObject({cascade:1,format:'markers',data:{markers:[{id:'mk_t',t:0},{id:'mk_c',t:2*S}]}})
  a.playback.seek(10*S);const ids=await a.clipboard.paste()
  expect(ids).toHaveLength(2);expect(ids).not.toContain('mk_t')
  expect(a.timeline().markers.slice(1)).toMatchObject([{t:10*S,kind:'unknown',note:'note',data:{x:1}},{t:12*S,name:'Source',color:'#82cbff'}])
  a.doc.undo();expect(a.timeline().markers).toHaveLength(1);expect(a.doc.canUndo).toBe(false)
  a.selection.setMarkers(['mk_t','mk_c']);await a.clipboard.cut()
  expect(a.timeline().markers).toEqual([]);expect(a.timeline().tracks[0].clips[0].markers).toEqual([])
  a.doc.undo();expect(a.timeline().markers).toHaveLength(1);expect(a.timeline().tracks[0].clips[0].markers).toHaveLength(1)
})
