import { expect, it } from 'vitest'
import { captureMarkers, chapterText, isMarkerData, markerColor, markerCsv, type MarkerEntry } from './data'
import { FLICKS as S } from '@shared/time'
const entry=(t:number,name:string,kind?:string):MarkerEntry=>({t:t*S,marker:{id:`m${t}`,t:t*S,name,kind}})
it('uses explicit marker colors then kind colors then white',()=>{
  const m=entry(0,'').marker
  expect(markerColor(m)).toBe('#ffffff');expect(markerColor(m,'red')).toBe('red');expect(markerColor({...m,color:'blue'},'red')).toBe('blue')
})
it('quotes CSV fields, including commas, newlines and quote characters',()=>{
  const e=entry(2,'A,"B"');e.marker.note='one\ntwo'
  expect(markerCsv([e])).toContain('"2","0","","A,""B""","marker","one\ntwo",""')
})
it('exports chapters only when present, forces zero, formats hours and deduplicates whole seconds',()=>{
  expect(chapterText([entry(2,'note'),entry(65,'Part one','chapter'),entry(3601,'Part two','chapter')])).toBe('0:00 Part one\n1:05 Part one\n1:00:01 Part two')
  expect(chapterText([entry(0,'Start'),entry(2,'Two'),entry(2.5,'Same second')])).toBe('0:00 Start\n0:02 Two')
  expect(chapterText([])).toBe('')
})
it('captures selected markers in timeline-relative time and preserves plugin metadata',()=>{
  const e=entry(3,'Third','unknown');e.marker.data={x:[1]};e.marker.note='note';e.clipId='c'
  const data=captureMarkers([entry(1,'First'),e],[e.marker.id])!
  expect(data.markers[0]).toMatchObject({t:0,kind:'unknown',data:{x:[1]},note:'note'})
  expect(isMarkerData(data)).toBe(true);expect(isMarkerData({markers:[{...e.marker,t:NaN}]})).toBe(false)
  expect(captureMarkers([e],[])).toBeNull()
})
