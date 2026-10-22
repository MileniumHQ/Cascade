import { expect, it } from 'vitest'
import { createProject, type Clip, type PropertyInstance } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { captureKeyframes, isKeyframeData, pasteKeyframes } from './keyframe-clipboard'
import type { PropertyContribution } from './plugin-api'
const def: PropertyContribution = { id:'custom',name:'Custom',description:'',icon:'bookmark',category:'Test',params:[{id:'x',label:'X',type:'number',default:0}],apply:()=>({}) }
const property = (id='p'): PropertyInstance => ({id,type:'custom',enabled:true,params:{x:{value:0,keyframes:[{id:'k1',t:S,value:1,easing:{id:'unknown',params:[2]}},{id:'k2',t:2*S,value:2,easing:{id:'linear'}}]}}})
const clip = (id='c',start=2*S): Clip => ({id,type:'unknown',name:'',start,duration:4*S,sourceIn:0,properties:[property()],data:{}})
const setup = () => {
  const p=createProject(''),tl=p.timelines[p.activeTimeline];tl.tracks[0].clips=[clip()]
  return captureKeyframes(tl,['k1','k2'].map(keyframeId=>({clipId:'c',propertyId:'p',paramId:'x',keyframeId})),()=>def)!
}
it('captures offsets from the earliest timeline keyframe and preserves values/easings without aliasing',()=>{
  const data=setup();expect(data.channels[0].keys.map(k=>k.t)).toEqual([0,S]);expect(isKeyframeData(data)).toBe(true)
  expect(data.channels[0].keys[0].easing).toEqual({id:'unknown',params:[2]})
  expect(isKeyframeData({channels:[{keys:[{t:NaN}]}]})).toBe(false)
})
it('matches the original instance on the same clip and replaces identical times',()=>{
  const data=setup(),c=clip();c.properties.unshift(property('first'))
  const selected=pasteKeyframes(c,data,3*S,()=>def,()=>true)
  expect(selected.every(k=>k.propertyId==='p')).toBe(true)
  expect(c.properties[1].params.x.keyframes).toHaveLength(2)
  expect(c.properties[1].params.x.keyframes![0].id).not.toBe('k1')
  expect(c.properties[0].params.x.keyframes![0].id).toBe('k1')
})
it('creates applicable missing properties and skips incompatible types, inapplicable media and out-of-range keys',()=>{
  const data=setup(),c=clip('target');c.properties=[]
  pasteKeyframes(c,data,5*S,()=>def,()=>true)
  expect(c.properties).toHaveLength(1);expect(c.properties[0].params.x.keyframes!.map(k=>k.t)).toEqual([3*S])
  const absent=clip();absent.properties=[]
  pasteKeyframes(absent,data,0,()=>def,()=>true);expect(absent.properties).toEqual([])
  pasteKeyframes(absent,data,3*S,()=>def,()=>false);expect(absent.properties).toEqual([])
  pasteKeyframes(absent,data,3*S,()=>({...def,params:[{...def.params[0],type:'text'}]}),()=>true);expect(absent.properties).toEqual([])
})
it('skips runtime value shapes that do not match the destination parameter',()=>{
  const data=setup(),c=clip('target');c.properties=[]
  data.channels[0].keys[0].value='wrong type';data.channels[0].keys[1].value=NaN
  expect(pasteKeyframes(c,data,3*S,()=>def,()=>true)).toEqual([]);expect(c.properties).toEqual([])
})
it('matches the first instance on a different clip and preserves offsets across source clips',()=>{
  const p=createProject(''),tl=p.timelines[p.activeTimeline]
  tl.tracks[0].clips=[clip('c',2*S),clip('other',8*S)]
  const data=captureKeyframes(tl,[{clipId:'other',propertyId:'p',paramId:'x',keyframeId:'k1'},{clipId:'c',propertyId:'p',paramId:'x',keyframeId:'k2'}],()=>def)!
  expect(data.channels.map(ch=>ch.keys[0].t)).toEqual([5*S,0])
  const target=clip('target');target.properties.unshift(property('first'))
  const selected=pasteKeyframes(target,setup(),3*S,()=>def,()=>true)
  expect(selected.every(k=>k.propertyId==='first')).toBe(true)
})
it('replaces colliding copied keys deterministically and selects only keys that survive',()=>{
  const data=setup(),c=clip('target')
  const other=structuredClone(data.channels[0]);other.keys[0].value=99;data.channels.push(other)
  const selected=pasteKeyframes(c,data,3*S,()=>def,()=>true)
  expect(c.properties[0].params.x.keyframes!.map(k=>k.value)).toEqual([99,2])
  expect(selected).toHaveLength(2)
})
it('keeps keyframes of properties whose plugin is unavailable and pastes them onto the same type id',()=>{
  const p=createProject(''),tl=p.timelines[p.activeTimeline];tl.tracks[0].clips=[clip()]
  const data=captureKeyframes(tl,['k1','k2'].map(keyframeId=>({clipId:'c',propertyId:'p',paramId:'x',keyframeId})),()=>undefined)!
  expect(data.channels[0].keys.map(k=>k.t)).toEqual([0,S])
  const c=clip('target');c.properties=[property('q')];c.properties[0].params.x.keyframes=[]
  const selected=pasteKeyframes(c,data,3*S,()=>undefined,()=>true)
  expect(selected).toHaveLength(2);expect(c.properties[0].params.x.keyframes!.map(k=>[k.t,k.value])).toEqual([[S,1],[2*S,2]])
  const bare=clip('bare');bare.properties=[]
  expect(pasteKeyframes(bare,data,3*S,()=>undefined,()=>true)).toEqual([])
})
