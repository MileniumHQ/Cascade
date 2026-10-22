import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { CascadeAPI } from '@core/app'
import type { PanelContext, TimelineDecorationContext } from '@core/plugin-api'
import { clipMarkerTimelineTime, findMarker, visibleMarkers } from '@core/markers'
import { clipEnd, type Clip, type Id, type Marker } from '@shared/project'
import { FLICKS, formatTimecode, type Flicks } from '@shared/time'
import { Button, IconButton, NumberField, openContextMenu, openDialog, Popover, Select, TextField, type Anchor, type MenuItem } from '@ui/kit'
import { useProject, useRegistry, useValue } from '@ui/reactive'
import { useSub } from '../solid'
import { markerColor } from './data'
import './markers.css'
export const swatches = ['#ffffff','#82cbff','#f2c14e','#ef8d8d','#bda3f5','#8dd5ac']
const openEditors = new Map<CascadeAPI, Set<() => void>>()
export function closeMarkerEditors(app: CascadeAPI) { for (const close of openEditors.get(app) ?? []) close(); openEditors.delete(app) }
export function openMarkerEditor(app: CascadeAPI, id: Id, anchor: Anchor = {x:window.innerWidth/2-150,y:100}) {
  if (!findMarker(app.timeline(),id)) return
  const editors=openEditors.get(app) ?? new Set<() => void>();openEditors.set(app,editors)
  const dispose=openDialog(close=><MarkerEditor app={app} id={id} anchor={anchor} close={()=>{close();editors.delete(dispose)}} />)
  editors.add(dispose)
}
function MarkerEditor(props: {app:CascadeAPI;id:Id;anchor:Anchor;close:()=>void}) {
  const app=props.app, initial=findMarker(app.timeline(),props.id)!, project=useProject(app), kinds=useRegistry(app.registries.markerKinds)
  const [name,setName]=createSignal(initial.marker.name), [note,setNote]=createSignal(initial.marker.note ?? ''), [kind,setKind]=createSignal(initial.marker.kind ?? 'marker')
  const [color,setColor]=createSignal(initial.marker.color), [duration,setDuration]=createSignal(initial.marker.duration ?? 0)
  const initialTime=initial.clip ? clipMarkerTimelineTime(initial.clip,app.edit.timeMap(initial.clip),initial.marker) : initial.marker.t
  const [time,setTime]=createSignal(initialTime ?? initial.marker.t)
  const found=()=>{project();return findMarker(app.timeline(),props.id)}
  const options=()=>kinds().some(k=>k.id===kind()) ? kinds().map(k=>({value:k.id,label:k.name})) : [{value:kind(),label:kind()},...kinds().map(k=>({value:k.id,label:k.name}))]
  const save=()=>{
    if (!found() || found()!.locked) return props.close()
    app.edit.updateMarker(props.id,{name:name(),note:note(),kind:kind(),color:color(),duration:duration(),...(initialTime===null ? {t:time()} : {})},{gesture:'start'})
    if (time()!==initialTime && initialTime!==null) app.edit.moveMarker(props.id,time(),{gesture:'end'})
    else app.doc.endGesture()
    props.close()
  }
  return <Popover anchor={props.anchor} onClose={props.close} width={310} class="marker-editor">
    <div class="marker-editor-title">Edit marker <IconButton icon="x" size="sm" onClick={props.close}/></div>
    <label>Name<TextField value={name()} onChange={setName} onInput={setName} autofocus/></label>
    <label>Kind<Select value={kind()} options={options()} onChange={setKind}/></label>
    <label>Color<div class="marker-swatches"><button class={!color()?'on':''} onClick={()=>setColor(undefined)}>Kind</button><For each={swatches}>{c=><button aria-label={`Color ${c}`} class={color()===c?'on':''} style={{background:c}} onClick={()=>setColor(c)}/>}</For></div></label>
    <label>{initialTime===null ? 'Source time' : 'Timeline time'}<NumberField value={time()/FLICKS} min={0} step={app.fps().den/app.fps().num} precision={3} suffix="s" onChange={v=>setTime(Math.round(v*FLICKS))}/></label>
    <label>Duration {initial.clip ? '(source)' : ''}<NumberField value={duration()/FLICKS} min={0} step={0.1} precision={3} suffix="s" onChange={v=>setDuration(Math.round(v*FLICKS))}/></label>
    <label>Note<TextField value={note()} onChange={setNote} onInput={setNote} multiline/></label>
    <div class="marker-editor-actions"><Button onClick={()=>{app.edit.removeMarkers([props.id]);props.close()}} disabled={!!initial.locked}>Delete</Button><Button variant="primary" onClick={save} disabled={!!initial.locked}>Save</Button></div>
  </Popover>
}
export function markerMenu(app: CascadeAPI, marker: Marker, anchor: Anchor): MenuItem[] {
  const locked=findMarker(app.timeline(),marker.id)?.locked
  return [
    {label:'Edit marker…',icon:'pencil',disabled:locked,run:()=>app.run('markers.edit',marker.id,anchor)},
    {label:'Color',children:[{label:'Kind color',disabled:locked,run:()=>app.run('markers.setColor',marker.id,undefined)},...swatches.map(color=>({label:color,disabled:locked,run:()=>app.run('markers.setColor',marker.id,color)}))]},
    {label:'Delete marker',icon:'trash-2',danger:true,disabled:locked,run:()=>app.edit.removeMarkers([marker.id])}
  ]
}
/** Marker pins on the ruler (timeline markers) or a clip body (source markers); the timeline supplies geometry and snapping. */
export function MarkerDecoration(props: {ctx:TimelineDecorationContext}) {
  const ctx=props.ctx, view=useSub(ctx.subscribe,()=>({width:ctx.width(),clip:ctx.clip()}))
  return <MarkerLayer app={ctx.app} clip={view().clip ?? undefined} x={t=>(view(),ctx.x(t))} width={view().width} snap={(t,exclude,alt)=>ctx.snap(t,exclude,alt)} />
}
function MarkerLayer(props: {app:CascadeAPI;clip?:Clip;x:(t:Flicks)=>number; width:number;snap:(t:Flicks,exclude:Set<Id>,alt:boolean)=>Flicks}) {
  const app=props.app, project=useProject(app), selected=useValue(app.selection.markers), kinds=useRegistry(app.registries.markerKinds)
  const entries=createMemo(()=>{
    project()
    if (!props.clip) return app.timeline().markers.map(marker=>({marker,t:marker.t}))
    const c=props.clip,map=app.edit.timeMap(c)
    return (c.markers ?? []).flatMap(marker=>{const t=clipMarkerTimelineTime(c,map,marker);return t===null ? [] : [{marker,t}]})
  })
  const snap=(t:Flicks,id:Id,alt:boolean)=>props.snap(t,new Set([id]),alt)
  let cleanup: (()=>void)|undefined
  onCleanup(()=>cleanup?.())
  const select=(id:Id,add=false)=>app.selection.setMarkers(add ? selected().includes(id) ? selected().filter(m=>m!==id) : [...selected(),id] : [id])
  const down=(e:PointerEvent,id:Id,t:Flicks)=>{
    if (e.button!==0) return
    e.stopPropagation();e.preventDefault();cleanup?.();select(id,e.shiftKey);app.playback.pause();app.playback.seek(t)
    if (findMarker(app.timeline(),id)?.locked) return
    const startX=e.clientX;let started=false
    const move=(ev:PointerEvent)=>{
      if (!started && Math.abs(ev.clientX-startX)<3) return
      const next=snap(Math.max(0,t+app.view.pxToTime(ev.clientX-startX)),id,ev.altKey)
      app.edit.moveMarker(id,next,{gesture:started?'update':'start'});started=true
    }
    const stop=()=>{if(started) app.doc.endGesture();window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);cleanup=undefined}
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);cleanup=stop
  }
  return <div class={`marker-layer ${props.clip?'clip-markers':''}`}><For each={entries()}>{({marker,t})=>{
    const range=()=>{
      const c=props.clip
      const end=c ? c.start+app.edit.timeMap(c).localAt(marker.t+(marker.duration ?? 0)-c.sourceIn) : t+(marker.duration ?? 0)
      const lo=c ? Math.max(c.start,Math.min(t,end)) : t, hi=c ? Math.min(clipEnd(c),Math.max(t,end)) : end
      return {left:Math.max(-10,props.x(lo)),width:Math.max(0,Math.min(props.width+10,props.x(hi))-Math.max(-10,props.x(lo)))}
    }
    const color=()=>markerColor(marker,kinds().find(k=>k.id===(marker.kind ?? 'marker'))?.color)
    return <Show when={props.x(t)>=-10 && props.x(t)<=props.width+10 || marker.duration && range().width>0}>
      <Show when={marker.duration && range().width>0}><span class="marker-band" style={{left:`${range().left}px`,width:`${range().width}px`,background:color()}}/></Show>
      <button class={`marker-pin ${selected().includes(marker.id)?'selected':''}`} style={{left:`${props.x(t)}px`,'--marker-color':color()}} title={marker.name || 'Marker'} data-tip={marker.note ? `${marker.name}: ${marker.note}` : marker.name || 'Marker'} aria-label={marker.name || 'Marker'}
        onPointerDown={e=>down(e,marker.id,t)} onDblClick={e=>{e.stopPropagation();app.run('markers.edit',marker.id,{x:e.clientX,y:e.clientY})}}
        onContextMenu={e=>{e.stopPropagation();select(marker.id);openContextMenu(e,markerMenu(app,marker,{x:e.clientX,y:e.clientY}))}}/>
    </Show>
  }}</For></div>
}
export function MarkersPanel(props:{ctx:PanelContext}) {
  const app=props.ctx.app, project=useProject(app), kinds=useRegistry(app.registries.markerKinds), selected=useValue(app.selection.markers)
  const [filter,setFilter]=createSignal('')
  const entries=createMemo(()=>{project();return visibleMarkers(app.timeline(),c=>app.edit.timeMap(c))})
  const hidden=createMemo(()=>{project();const visible=new Set(entries().map(e=>e.marker.id));return app.timeline().tracks.flatMap(tr=>tr.clips.flatMap(clip=>(clip.markers??[]).filter(m=>!visible.has(m.id)).map(marker=>({marker,clip}))))})
  const options=()=>[{value:'',label:'All kinds'},...Array.from(new Set([...kinds().map(k=>k.id),...entries().map(e=>e.marker.kind ?? 'marker'),...hidden().map(e=>e.marker.kind ?? 'marker')])).map(id=>({value:id,label:kinds().find(k=>k.id===id)?.name ?? id}))]
  const matches=(m:Marker)=>!filter() || (m.kind ?? 'marker')===filter()
  const choose=(id:Id,t:Flicks|null,shift:boolean)=>{app.selection.setMarkers(shift?[...new Set([...selected(),id])]:[id]);if(t!==null)app.playback.seek(t)}
  return <div class="markers-panel">
    <div class="markers-toolbar"><Button onClick={()=>app.run('markers.add')}>Add marker</Button><Select value={filter()} options={options()} onChange={setFilter}/><Button onClick={()=>app.run('markers.exportCsv')}>Copy CSV</Button><Button onClick={()=>app.run('markers.copyChapters')}>Copy chapters</Button></div>
    <div class="markers-list"><For each={entries().filter(e=>matches(e.marker))}>{e=><div class={`marker-row ${selected().includes(e.marker.id)?'selected':''}`} onClick={ev=>{if(!(ev.target as HTMLElement).closest('input,textarea,button'))choose(e.marker.id,e.t,ev.shiftKey)}} onContextMenu={ev=>{app.selection.setMarkers([e.marker.id]);openContextMenu(ev,markerMenu(app,e.marker,{x:ev.clientX,y:ev.clientY}))}}>
      <i style={{background:markerColor(e.marker,kinds().find(k=>k.id===(e.marker.kind ?? 'marker'))?.color)}}/>
      <button class="marker-time tnum" onClick={ev=>choose(e.marker.id,e.t,ev.shiftKey)}>{formatTimecode(e.t,app.fps())}</button>
      <TextField value={e.marker.name} onChange={name=>app.edit.updateMarker(e.marker.id,{name})}/>
      <span>{kinds().find(k=>k.id===(e.marker.kind ?? 'marker'))?.name ?? e.marker.kind ?? 'Marker'}</span><span class="marker-note" title={e.marker.note}>{e.marker.note}</span><span class="marker-source">{e.clip?.name}</span>
      <IconButton icon="pencil" tip="Edit marker" onClick={ev=>app.run('markers.edit',e.marker.id,ev.currentTarget)}/><IconButton icon="trash-2" tip="Delete marker" onClick={()=>app.edit.removeMarkers([e.marker.id])}/>
    </div>}</For>
    <For each={hidden().filter(e=>matches(e.marker))}>{e=><div class="marker-row marker-hidden" onClick={ev=>choose(e.marker.id,null,ev.shiftKey)}><i style={{background:markerColor(e.marker,kinds().find(k=>k.id===(e.marker.kind ?? 'marker'))?.color)}}/><span class="tnum">{formatTimecode(e.marker.t,app.fps())} source</span><TextField value={e.marker.name} onChange={name=>app.edit.updateMarker(e.marker.id,{name})}/><span>{e.marker.kind ?? 'marker'}</span><span class="marker-note">{e.marker.note}</span><span>{e.clip.name} (trimmed out)</span><IconButton icon="pencil" onClick={ev=>app.run('markers.edit',e.marker.id,ev.currentTarget)}/><IconButton icon="trash-2" onClick={()=>app.edit.removeMarkers([e.marker.id])}/></div>}</For>
    <Show when={!entries().length && !hidden().length}><p class="markers-empty">No markers</p></Show></div>
  </div>
}
