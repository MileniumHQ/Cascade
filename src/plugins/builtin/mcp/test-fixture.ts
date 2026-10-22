import { CascadeApp } from '@core/app'
import { PluginHost } from '@core/plugin-host'
import type { HostBridge } from '@shared/ipc'
import { FLICKS } from '@shared/time'
import { easingsPlugin } from '../easings'
import { videoPlugin } from '../media/video'
import { audioPlugin } from '../media/audio'
import { elementPlugin } from '../media/element'
import { sequencePlugin } from '../sequence'
import { timePropertiesPlugin } from '../properties/time'
import { visualPropertiesPlugin } from '../properties/visual'
import { textPropertiesPlugin } from '../properties/text'
import { audioPropertiesPlugin } from '../properties/audio'
import { visualTransitions, audioCrossfade } from '../transitions/effects'
import { CAPTION_STYLE_KIND } from '../captions/styles'
import { applyEdits, Ids } from './edits'

export const S = (s: number) => Math.round(s * FLICKS)
export async function primitiveEditor(bridge: HostBridge | null = null) {
  const app = new CascadeApp('editor', bridge), host = new PluginHost(app)
  await host.activateAll([easingsPlugin, videoPlugin, audioPlugin, elementPlugin, sequencePlugin, timePropertiesPlugin, visualPropertiesPlugin, textPropertiesPlugin, audioPropertiesPlugin].map(def => ({ def, builtin: true })))
  for (const tx of [...visualTransitions, audioCrossfade]) app.registries.transitions.register(tx, 'fixture', true)
  app.registries.transitions.register({ id: 'custom-transition', name: 'Custom', description: 'Third-party', icon: 'layers', kinds: ['visual'], params: [{ id: 'amount', label: 'Amount', type: 'number', default: 0, min: 0, max: 1 }] }, 'third-party', false)
  app.registries.markerKinds.register({ id: 'custom-kind', name: 'Custom kind', color: '#82cbff' }, 'third-party', false)
  app.registries.presets.register({ id: 'custom-style', name: 'Custom style', kind: CAPTION_STYLE_KIND, group: 'Third-party', value: { text: { color: '#ff0000' } } }, 'third-party', false)
  app.registries.presets.register({ id: 'other-preset', name: 'Other', kind: 'another.kind', value: {} }, 'third-party', false)
  app.doc.transact('Fixture', d => {
    d.media.footage = { id: 'footage', type: 'video', name: 'Footage', path: '/footage.mp4', meta: { duration: S(120), hasAudio: true, hasVideo: true } }
    d.mediaOrder.push('footage')
  })
  const ids = new Ids()
  const edit = (ops: Record<string, unknown>[], dryRun = false) => applyEdits(app, { ops }, ids, undefined, { dryRun })
  const addThree = () => {
    edit([0, 1, 2].map(i => ({ op: 'add_clip', mediaId: 'footage', start: S(i * 4), sourceIn: S(10 + i * 4), duration: S(4) })))
    return app.timeline().tracks[0].clips.map(c => c.id)
  }
  return { app, ids, edit, addThree }
}
