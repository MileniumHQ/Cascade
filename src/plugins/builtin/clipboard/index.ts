import { definePlugin } from '@core/plugin-api'
import { captureClips, parseClipboard, type ClipClipboardPayload } from './clips'
import { captureKeyframes, isKeyframeData, pasteKeyframes } from '@core/keyframe-clipboard'
import { clipTimeMap } from '@core/time-remap'
import { withTimeMaps } from '@core/timeline-ops'
import { pasteClips } from './clips'
import { clipEnd, findClip } from '@shared/project'
import { expandLinked } from '@core/timeline-ops'
import { rippleOptions } from '../ripple'
export const clipboardPlugin = definePlugin({
  id: 'builtin.clipboard', name: 'Clipboard formats',
  activate(ctx) {
    ctx.clipboardFormats.register({
      id:'clips', priority:-1000,
      decode:text => { const p = parseClipboard(text); return p?.cascade === 'clips' ? p : null },
      canCopy:(a,context) => !context?.property && (context?.ids ?? a.selection.clips.get()).length > 0,
      copy:(a,context) => {
        const ids=context?.ids ?? a.selection.clips.get(), primary=a.selection.primaryClip
        return captureClips(a.project(), primary ? [primary,...ids.filter(id=>id!==primary)] : ids)
      },
      canPaste:(_a,data,context) => !context?.property && parseClipboard(JSON.stringify(data))?.cascade === 'clips',
      paste:(a,data,opts) => {
        const payload = data as ClipClipboardPayload, at = a.playback.time.get()
        let ids: string[] | null = null
        a.doc.transact(opts.insert ? 'Paste insert' : 'Paste', d => {
          ids = withTimeMaps(c => clipTimeMap(c, d.timelines[d.activeTimeline], a.registries), () => pasteClips(d, payload, at, a.selection.track.get(), opts.insert, rippleOptions(a).rippleMarkers))
        })
        if (!ids) { a.notify('warning', 'Paste blocked by a locked track or an incompatible linked clip boundary'); return [] }
        a.selection.setClips(ids)
        a.playback.seek(at + Math.max(...payload.clips.map(e => clipEnd(e.clip))))
        return ids
      },
      remove:(a,data) => {
        const ids=(data as ClipClipboardPayload).clips.map(e=>e.clip.id)
        if (![...expandLinked(a.timeline(),ids)].some(id=>findClip(a.timeline(),id)?.track.locked)) a.edit.deleteClips(ids,rippleOptions(a))
      }
    })
    ctx.clipboardFormats.register({
      id: 'property', priority: 200,
      decode: text => { const p = parseClipboard(text); return p?.cascade === 'property' ? p : null },
      canCopy: (a, context) => !!context?.property?.clipId && !!findClip(a.timeline(), context.property.clipId)?.clip.properties.some(p => p.id === context.property?.propertyId),
      copy: (a, context) => ({ cascade: 'property', version: 1, property: findClip(a.timeline(), context!.property!.clipId!)!.clip.properties.find(p => p.id === context!.property!.propertyId)! }),
      canPaste: (_a, data) => parseClipboard(JSON.stringify(data))?.cascade === 'property',
      paste: (a, data, opts) => { const p = parseClipboard(JSON.stringify(data)); if (p?.cascade === 'property') a.edit.pasteProperties(opts.context?.ids ?? a.selection.clips.get(), [p.property]) }
    })
    ctx.clipboardFormats.register({
      id:'keyframes', priority:100,
      canCopy:(a,context) => !context && a.selection.keyframes.get().length > 0,
      copy:a => captureKeyframes(a.timeline(),a.selection.keyframes.get(),id=>a.registries.properties.get(id)),
      canPaste:(_a,data,context) => !context?.property && isKeyframeData(data),
      paste:(a,data) => {
        if (!isKeyframeData(data)) return
        const selection: typeof a.selection.keyframes extends { get(): infer T } ? T : never = []
        const ids=a.selection.clips.get(), at=a.playback.time.get()
        a.doc.transact('Paste keyframes',d=>{
          for (const id of ids) {
            const f=findClip(d.timelines[d.activeTimeline],id)
            if (f && !f.track.locked) selection.push(...pasteKeyframes(f.clip,data,at,id=>a.registries.properties.get(id),(def,c)=>a.edit.propertyApplies(def,c)))
          }
        })
        a.selection.keyframes.set(selection)
      },
      remove:(a,data) => {
        if (!isKeyframeData(data)) return
        a.doc.transact('Cut keyframes',d=>{
          for (const ch of data.channels) {
            const f=findClip(d.timelines[d.activeTimeline],ch.clipId)
            if (!f || f.track.locked) continue
            const pv=f.clip.properties.find(p=>p.id===ch.propertyId)?.params[ch.param]
            if (pv?.keyframes) pv.keyframes=pv.keyframes.filter(k=>!ch.keys.some(key=>key.id===k.id))
          }
        })
        a.selection.keyframes.set([])
      }
    })
  }
})
