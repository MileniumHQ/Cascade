import { afterEach, expect, it, vi } from 'vitest'
import { CascadeApp } from './app'
import { parseClipboard, type ClipboardFormatContribution } from './clipboard'
import { parseClipboard as parseLegacyClipboard } from '../plugins/builtin/clipboard/clips'
import { clipboardPlugin } from '../plugins/builtin/clipboard'
import { PluginHost } from './plugin-host'
import { createProject, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
afterEach(()=>vi.unstubAllGlobals())
it('uses highest priority format, dispatches serialized data and cuts through its optional deletion primitive',async()=>{
  const a=new CascadeApp('editor',null),calls:string[]=[]
  for(const [id,priority] of [['low',1],['high',9]] as const) {
    const f:ClipboardFormatContribution={id,priority,canCopy:()=>true,copy:()=>({id}),canPaste:()=>true,paste:(_a,d,o)=>{calls.push(`${(d as any).id}:${o.insert}`)},remove:()=>{calls.push(`cut:${id}`)}}
    a.registries.clipboardFormats.register(f,'test',true)
  }
  await a.clipboard.copy();expect(await a.clipboard.read()).toEqual({cascade:1,format:'high',data:{id:'high'}})
  await a.clipboard.paste(true);await a.clipboard.cut();expect(calls).toEqual(['high:true','cut:high'])
  expect(parseClipboard('{"cascade":1,"format":"unknown","data":{"preserve":true}}')).toEqual({cascade:1,format:'unknown',data:{preserve:true}})
  expect(parseClipboard('{"cascade":1,"format":"x"}')).toBeNull()
})
it('uses keyframes over clips, preserves clip selection, and pastes missing properties in a single undo',async()=>{
  const p=createProject(''),tl=p.timelines[p.activeTimeline]
  const c:Clip={id:'c',type:'unknown',name:'',start:0,duration:10*S,sourceIn:0,properties:[{id:'p',type:'custom',enabled:true,params:{x:{value:0,keyframes:[{id:'k',t:S,value:3,easing:{id:'linear'}}]}}}],data:{}}
  tl.tracks[0].clips=[c,{...c,id:'target',start:10*S,properties:[]}]
  const a=new CascadeApp('editor',null,p);await new PluginHost(a).activate(clipboardPlugin,true)
  a.registries.properties.register({id:'custom',name:'Custom',description:'',icon:'bookmark',category:'Test',params:[{id:'x',label:'X',type:'number',default:0}]},'test',true)
  a.selection.setClips(['c']);a.selection.keyframes.set([{clipId:'c',propertyId:'p',paramId:'x',keyframeId:'k'}]);await a.clipboard.copy()
  expect((await a.clipboard.read())?.cascade).toBe(1)
  a.selection.setClips(['target']);a.playback.seek(11*S);await a.clipboard.paste()
  expect(a.timeline().tracks[0].clips[1].properties[0].params.x.keyframes![0]).toMatchObject({t:S,value:3})
  a.doc.undo();expect(a.timeline().tracks[0].clips[1].properties).toEqual([]);expect(a.doc.canUndo).toBe(false)
  a.selection.keyframes.set([{clipId:'c',propertyId:'p',paramId:'x',keyframeId:'k'}]);await a.clipboard.cut();expect(a.timeline().tracks[0].clips[0].properties[0].params.x.keyframes).toEqual([])
  a.doc.undo();expect(a.timeline().tracks[0].clips[0].properties[0].params.x.keyframes).toHaveLength(1)
})
it('reads old clip payloads through the built-in clips format and writes envelopes in the app',async()=>{
  let text='';vi.stubGlobal('navigator',{clipboard:{writeText:async(s:string)=>{text=s},readText:async()=>text}})
  const p=createProject('');p.timelines[p.activeTimeline].tracks[0].clips=[{id:'c',type:'unknown',name:'',start:0,duration:S,sourceIn:0,properties:[],data:{}}]
  const a=new CascadeApp('editor',null,p);await new PluginHost(a).activate(clipboardPlugin,true);a.selection.setClips(['c']);await a.clipboard.copy()
  const payload=JSON.parse(text);expect(payload.format).toBe('clips');text=JSON.stringify(payload.data)
  a.playback.seek(2*S);expect(await a.clipboard.paste()).toHaveLength(1)
})
it('rejects malformed source markers inside an otherwise valid clip payload',()=>{
  const clip={id:'c',type:'unknown',name:'',start:0,duration:S,sourceIn:0,properties:[],data:{},markers:[null]}
  const payload={cascade:'clips',version:1,clips:[{clip,kind:'visual',trackOffset:0,sourceTrack:'t'}],media:[]}
  expect(parseLegacyClipboard(JSON.stringify(payload))).toBeNull()
})
it('dispatches explicit clip and property contexts to contributions without a built-in fallback', async () => {
  const a = new CascadeApp('editor', null), contexts: unknown[] = []
  a.registries.clipboardFormats.register({ id: 'third-party', priority: 10,
    canCopy: (_a, context) => !!context,
    copy: (_a, context) => { contexts.push(context); return context },
    canPaste: () => true, paste: (_a, _data, opts) => { contexts.push(opts.context) }, remove: () => {}
  }, 'test', true)
  await a.clipboard.copy(['explicit'])
  expect(await a.clipboard.read()).toMatchObject({ cascade: 1, format: 'third-party', data: { ids: ['explicit'] } })
  await a.clipboard.cut(['cut'])
  await a.clipboard.copyProperty('clip', 'property')
  await a.clipboard.pasteProperty(['target'])
  expect(contexts).toEqual([{ ids: ['explicit'] }, { ids: ['cut'] }, { property: { clipId: 'clip', propertyId: 'property' } }, { ids: ['target'], property: {} }])
  const empty = new CascadeApp('editor', null)
  expect(await empty.clipboard.paste()).toEqual([])
})
