import { describe, expect, it } from 'vitest'
import { createProject, type Clip } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { clipMarkerSourceTime, clipMarkerTimelineTime, normalizeProjectMarkers, shiftMarkers } from './markers'
import { constantMap, reverseMap } from './time-remap'
import { splitClip, withTimeMaps, snapPoints } from './timeline-ops'
import { insertTime, closeLinkedGap, rippleTrim } from './advanced-timeline-ops'
const clip = (): Clip => ({ id: 'c', type: 'unknown', name: '', start: 10*S, duration: 4*S, sourceIn: 20*S, properties: [], data: {} })
describe('source markers', () => {
  it.each([1, 2, -1, -2])('round trips at speed %s', speed => {
    const c = clip(), map = speed < 0 ? reverseMap(constantMap(-speed)) : constantMap(speed)
    const t = clipMarkerSourceTime(c, map, 11*S)
    expect(t).toBe((20 + speed)*S)
    expect(clipMarkerTimelineTime(c, map, { id: 'm', t, name: '' })).toBe(11*S)
    expect(clipMarkerTimelineTime(c, map, { id: 'm', t: 100*S, name: '' })).toBeNull()
  })
  it('splits markers into exactly one half, including a reversed boundary', () => {
    const p = createProject(''), tr = p.timelines[p.activeTimeline].tracks[0], c = clip()
    c.markers = [23,22,21].map((n,i) => ({ id: `m${i}`, t: n*S, name: '' }))
    c.sourceIn = 24*S; tr.clips = [c]
    withTimeMaps(() => reverseMap(constantMap(1)), () => splitClip(tr, 'c', 12*S))
    expect(tr.clips[0].markers!.map(m => m.t)).toEqual([23*S])
    expect(tr.clips[1].markers!.map(m => m.t)).toEqual([22*S,21*S])
    expect(new Set(tr.clips.flatMap(c => c.markers!.map(m => m.id))).size).toBe(3)
  })
  it('normalizes known fields and preserves unknown metadata', () => {
    const p = createProject(''), tl = p.timelines[p.activeTimeline]
    tl.markers = [{ id:'m', t: 1.8, name: '', duration: -4, kind: 'third-party', data: { x: 42 }, ...{ future: true } }]
    normalizeProjectMarkers(p)
    expect(tl.markers[0]).toMatchObject({ t:2, duration:0, kind:'third-party', data:{ x:42 }, future:true })
  })
  it('adds only visible source markers to snapping', () => {
    const p = createProject(''), tl = p.timelines[p.activeTimeline], c = clip()
    c.markers = [{id:'m', t:22*S, name:''}, {id:'hidden', t:90*S, name:''}]; tl.tracks[0].clips=[c]
    withTimeMaps(() => constantMap(2), () => expect(snapPoints(tl, new Set())).toContain(11*S))
    expect(snapPoints(tl, new Set(['m']))).not.toContain(12*S)
  })
})
describe('marker ripple', () => {
  const markers = [1,2,3,4,5].map(t => ({ id:`m${t}`, t:S*t, name:'', kind:'unknown' }))
  it('inserts and deletes using half-open intervals without mutating the input', () => {
    expect(shiftMarkers(markers,2*S,S).map(m=>m.t/S)).toEqual([1,3,4,5,6])
    expect(shiftMarkers(markers,2*S,-2*S).map(m=>m.t/S)).toEqual([1,2,3])
    expect(markers.map(m=>m.t/S)).toEqual([1,2,3,4,5])
  })
  it('shifts on insert, gap close and ripple trim and honors opt out', () => {
    const p=createProject(''), tl=p.timelines[p.activeTimeline], tr=tl.tracks[0]
    tr.clips=[{...clip(),start:0,sourceIn:0}]; tl.markers=[{id:'m',t:5*S,name:''}]
    insertTime(tl,[tr.id],2*S,S); expect(tl.markers[0].t).toBe(6*S)
    closeLinkedGap(tl,tr.id,2*S); expect(tl.markers[0].t).toBe(5*S)
    rippleTrim(tl,tr.clips[1].id,'end',5*S); expect(tl.markers[0].t).toBe(6*S)
    insertTime(tl,[tr.id],0,S,false); expect(tl.markers[0].t).toBe(6*S)
  })
})
it('partitions markers when overwrite creates two surviving clip halves',async()=>{
  const {clearRange}=await import('./timeline-ops')
  const p=createProject(''),tr=p.timelines[p.activeTimeline].tracks[0],c=clip()
  c.markers=[20,21,22,23].map(n=>({id:`m${n}`,t:n*S,name:''}));tr.clips=[c]
  clearRange(tr,11*S,13*S)
  expect(tr.clips.map(c=>c.markers!.map(m=>m.t/S))).toEqual([[20],[23]])
})
