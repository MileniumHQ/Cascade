import { expect, it } from 'vitest'
import { CascadeApp } from './app'
import { createProject, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
const setup = () => {
  const p=createProject(''), tr=p.timelines[p.activeTimeline].tracks[0]
  tr.clips=[{id:'c',type:'unknown',name:'',start:2*S,duration:8*S,sourceIn:10*S,speed:2,properties:[],data:{}} as Clip]
  return new CascadeApp('editor',null,p)
}
it('supports full timeline and source-marker CRUD, retaining plugin data and undo', () => {
  const a=setup(), id=a.edit.addMarker(3*S,'Source',{clipId:'c',kind:'external',data:{keep:true}})
  expect(a.timeline().tracks[0].clips[0].markers![0].t).toBe(12*S)
  a.edit.moveMarker(id,4*S); a.edit.updateMarker(id,{name:'Renamed',duration:S,color:'#fff',note:'Note'})
  expect(a.timeline().tracks[0].clips[0].markers![0]).toMatchObject({t:14*S,name:'Renamed',kind:'external',data:{keep:true}})
  a.edit.removeMarkers([id]); expect(a.timeline().tracks[0].clips[0].markers).toEqual([])
  a.doc.undo(); expect(a.timeline().tracks[0].clips[0].markers).toHaveLength(1)
  const timeline=a.edit.addMarker(S); expect(a.timeline().markers[0].id).toBe(timeline)
})
it('coalesces drags into one undo step and keeps distinct drags separate', () => {
  const a=setup(), id=a.edit.addMarker(S)
  a.edit.moveMarker(id,2*S,{gesture:'start'}); a.edit.moveMarker(id,3*S,{gesture:'update'}); a.edit.moveMarker(id,4*S,{gesture:'end'})
  a.edit.moveMarker(id,5*S,{gesture:'start'}); a.edit.moveMarker(id,6*S,{gesture:'end'})
  a.doc.undo(); expect(a.timeline().markers[0].t).toBe(4*S)
  a.doc.undo(); expect(a.timeline().markers[0].t).toBe(S)
})
it('locks clip markers and enforces exclusive marker/clip selections', () => {
  const a=setup(), id=a.edit.addMarker(3*S,'',{clipId:'c'})
  a.selection.setMarkers([id]); a.selection.setClips(['c']); expect(a.selection.markers.get()).toEqual([])
  a.selection.setMarkers([id]); expect(a.selection.clips.get()).toEqual([])
  a.doc.transact('Lock',d=>{d.timelines[d.activeTimeline].tracks[0].locked=true})
  const before=JSON.stringify(a.project()); a.edit.moveMarker(id,5*S); a.edit.removeMarkers([id]); a.edit.addMarker(S,'',{clipId:'c'})
  expect(JSON.stringify(a.project())).toBe(before)
})
it('ripples markers once for linked deletion and preserves them when disabled', () => {
  const a=setup(), p=a.project(), v=a.timeline().tracks[0].clips[0]
  a.doc.transact('Linked',d=>{const tl=d.timelines[p.activeTimeline];tl.tracks[0].clips[0].linkId='l';tl.tracks[3].clips=[{...v,id:'a',linkId:'l'}]})
  a.edit.addMarker(12*S); a.edit.deleteClips(['c'],true); expect(a.timeline().markers[0].t).toBe(4*S)
  a.doc.undo(); a.edit.deleteClips(['c'],{ripple:true,rippleMarkers:false}); expect(a.timeline().markers[0].t).toBe(12*S)
})
it('clears markers with Deselect and routes Delete to selected markers before clips',async()=>{
  const {PluginHost}=await import('./plugin-host'), {commandsPlugin}=await import('../plugins/builtin/commands')
  const a=setup();await new PluginHost(a).activate(commandsPlugin,true)
  const id=a.edit.addMarker(S);a.selection.setMarkers([id]);a.run('timeline.deselect');expect(a.selection.markers.get()).toEqual([])
  a.selection.setMarkers([id]);a.run('timeline.delete');expect(a.timeline().markers).toEqual([]);expect(a.timeline().tracks[0].clips).toHaveLength(1)
})
it('keeps marker times and durations finite integers',()=>{
  const a=setup(),id=a.edit.addMarker(1.2,'',{duration:Infinity})
  expect(a.timeline().markers[0]).toMatchObject({t:1,duration:0})
  a.edit.updateMarker(id,{t:NaN,duration:Infinity});expect(a.timeline().markers[0]).toMatchObject({t:1,duration:0})
})
