import type { KeyframeSelection } from './app'
import { findClip, uid, type Clip, type Id, type Keyframe, type Timeline } from '@shared/project'
import type { Flicks } from '@shared/time'
import type { PropertyContribution } from './plugin-api'
import { defaultParams } from './evaluate'
export interface KeyframeClipboardData {
  channels: { clipId: Id; propertyId: Id; type: string; param: string; valueType: string; keys: Keyframe[] }[]
}
export function captureKeyframes(tl: Timeline, selection: KeyframeSelection[], definitions: (id: string) => PropertyContribution | undefined): KeyframeClipboardData | null {
  const channels: KeyframeClipboardData['channels'] = []
  for (const sel of selection) {
    const c = findClip(tl, sel.clipId)?.clip, p = c?.properties.find(p => p.id === sel.propertyId)
    const k = p?.params[sel.paramId]?.keyframes?.find(k => k.id === sel.keyframeId)
    const def = p && definitions(p.type)?.params.find(d => d.id === sel.paramId)
    if (!c || !p || !k || !def) continue
    let channel = channels.find(ch => ch.clipId === c.id && ch.propertyId === p.id && ch.param === sel.paramId)
    if (!channel) channels.push(channel = { clipId: c.id, propertyId: p.id, type: p.type, param: sel.paramId, valueType: def.type, keys: [] })
    if (!channel.keys.some(key => key.id === k.id)) channel.keys.push({ ...structuredClone(k), t: c.start + k.t })
  }
  if (!channels.length) return null
  const origin = Math.min(...channels.flatMap(c => c.keys.map(k => k.t)))
  for (const ch of channels) for (const key of ch.keys) key.t -= origin
  return { channels }
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export function isKeyframeData(data: unknown): data is KeyframeClipboardData {
  return record(data) && Array.isArray(data.channels) && data.channels.length > 0 && data.channels.every((ch: unknown) => record(ch) && ['clipId','propertyId','type','param','valueType'].every(k => typeof ch[k] === 'string') && Array.isArray(ch.keys) && ch.keys.length > 0 && ch.keys.every((k: unknown) => record(k) && typeof k.id === 'string' && Number.isSafeInteger(k.t) && k.t >= 0 && Object.hasOwn(k,'value') && record(k.easing) && typeof k.easing.id === 'string' && (k.easing.params === undefined || Array.isArray(k.easing.params) && k.easing.params.every(Number.isFinite))))
}
/** Mutable, property-neutral paste mapping. Returns selection refs for the newly pasted keys. */
export function pasteKeyframes(clip: Clip, data: KeyframeClipboardData, at: Flicks, definitions: (id: string) => PropertyContribution | undefined, applies: (def: PropertyContribution, clip: Clip) => boolean): KeyframeSelection[] {
  const selected: KeyframeSelection[] = []
  for (const ch of data.channels) {
    const def = definitions(ch.type), param = def?.params.find(d => d.id === ch.param)
    if (!def || !param || param.type !== ch.valueType || param.animatable === false || !applies(def, clip)) continue
    const keys = ch.keys.map(k => ({ ...structuredClone(k), id: uid('kf_'), t: Math.round(at - clip.start + k.t) })).filter(k => k.t >= 0 && k.t < clip.duration)
    if (!keys.length) continue
    let prop = clip.properties.find(p => p.id === ch.propertyId && clip.id === ch.clipId && p.type === ch.type) ?? clip.properties.find(p => p.type === ch.type)
    if (!prop) clip.properties.push(prop = { id: uid('pi_'), type: ch.type, enabled: true, params: defaultParams(def) })
    const pv = (prop.params[ch.param] ??= { value: structuredClone(param.default) })
    const times = new Set(keys.map(k => k.t))
    pv.keyframes = [...(pv.keyframes ?? []).filter(k => !times.has(k.t)), ...keys].sort((a,b) => a.t - b.t)
    selected.push(...keys.map(k => ({ clipId: clip.id, propertyId: prop.id, paramId: ch.param, keyframeId: k.id })))
  }
  return selected
}
