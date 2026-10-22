import './editing.css'
import { parseClipboard } from '../clipboard/clips'
import { createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import { definePlugin, type CommandContribution, type MenuLocation, type PropertyInstance } from '@core/plugin-api'
import type { CascadeAPI } from '@core/app'
import { clipEnd, findClip } from '@shared/project'
import { Button, Modal } from '@ui/kit'

/** Modal state belongs to this plugin, so hot-unloading it also closes any open dialog. */
export const editingPlugin = definePlugin({
  id: 'cascade.editing', name: 'Timeline editing',
  activate(ctx) {
    let closeModal: (() => void) | undefined
    ctx.track({ dispose() { closeModal?.() } })
    const attributes = async (app: CascadeAPI) => {
      const raw = await app.clipboard.read()
      const payload = raw ? parseClipboard(JSON.stringify(raw.data)) : null
      const properties = payload?.cascade === 'clips' ? payload.clips[0].clip.properties : payload?.cascade === 'property' ? [payload.property] : []
      if (!properties.length || !app.selection.clips.get().length) return
      closeModal?.()
      const ids = [...app.selection.clips.get()]
      const project = app.project().id
      const types = [...new Set(properties.map((p) => p.type))]
      const host = document.createElement('div')
      document.body.append(host)
      let dispose: (() => void) | undefined
      const close = () => { dispose?.(); host.remove(); closeModal = undefined }
      closeModal = close
      dispose = render(() => {
        const [chosen, setChosen] = createSignal(new Set(types))
        const [keyframes, setKeyframes] = createSignal(true)
        const apply = () => {
          if (app.project().id === project) app.edit.pasteProperties(ids, properties.filter((p) => chosen().has(p.type)) as PropertyInstance[], { includeKeyframes: keyframes() })
          close()
        }
        return <Modal title="Paste attributes" icon="clipboard-paste" width={340} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={apply} disabled={!chosen().size}>Paste</Button></>}>
          <div class="paste-attributes-list">
            <For each={types}>{(type) => <label><input type="checkbox" checked={chosen().has(type)} onChange={(e) => setChosen((old) => { const next = new Set(old); if (e.currentTarget.checked) next.add(type); else next.delete(type); return next })} />{app.registries.properties.get(type)?.name ?? type}</label>}</For>
            <label class="paste-attributes-keyframes"><input type="checkbox" checked={keyframes()} onChange={(e) => setKeyframes(e.currentTarget.checked)} />Include keyframes</label>
          </div>
        </Modal>
      }, host)
    }
    ctx.settings.register({ id: 'timeline.rippleMode', label: 'Ripple mode', description: 'Trims, Delete and Cut close time on affected linked tracks', section: 'Timeline', type: 'toggle', default: false })
    ctx.settings.register({ id: 'timeline.freezeDuration', label: 'Frame hold duration (seconds)', section: 'Timeline', type: 'number', default: 2 })
    const commands: (CommandContribution & { key?: string; locations?: MenuLocation[] })[] = [
      { id: 'edit.copy', title: 'Copy', key: 'Mod+C', icon: 'copy', run: (a) => a.clipboard.copy(), locations: ['app/edit', 'clip/context'] },
      { id: 'edit.cut', title: 'Cut', key: 'Mod+X', icon: 'scissors', run: (a) => a.clipboard.cut(), locations: ['app/edit', 'clip/context'] },
      { id: 'edit.paste', title: 'Paste', key: 'Mod+V', icon: 'clipboard-paste', run: (a) => a.clipboard.paste(), locations: ['app/edit', 'clip/context', 'timeline/context'] },
      { id: 'edit.pasteInsert', title: 'Paste insert', key: 'Mod+Shift+V', run: (a) => a.clipboard.paste(true), locations: ['app/edit', 'clip/context', 'timeline/context'] },
      { id: 'edit.pasteAttributes', title: 'Paste attributes…', key: 'Mod+Alt+V', run: attributes, locations: ['app/edit', 'clip/context'] },
      { id: 'edit.copyProperty', title: 'Copy property', run: (a, clipId, propertyId) => a.clipboard.copyProperty(clipId, propertyId) },
      { id: 'edit.pasteProperty', title: 'Paste property', run: (a, clipId) => a.clipboard.pasteProperty(clipId ? [clipId] : undefined) },
      { id: 'timeline.toggleRippleMode', title: 'Ripple mode', key: 'Shift+R', icon: 'ripple-trim', run: (a) => a.settings.set('timeline.rippleMode', !a.settings.get<boolean>('timeline.rippleMode')), locations: ['app/timeline'] },
      { id: 'timeline.closeGap', title: 'Close gap', run: (a, target?: { trackId: string; t: number }) => {
        const track = target?.trackId ?? a.selection.track.get() ?? a.timeline().tracks.find((tr) => !tr.locked)?.id
        if (track) a.edit.closeGap(track, target?.t)
      }, locations: ['app/timeline', 'timeline/context'] },
      { id: 'timeline.closeAllGaps', title: 'Close all gaps', run: (a) => a.edit.closeAllGaps(), locations: ['app/timeline'] },
      { id: 'clip.freezeFrame', title: 'Freeze frame', key: 'Shift+F', icon: 'pause', run: (a) => {
        const t = a.playback.time.get()
        const selected = a.selection.clips.get().map((id) => findClip(a.timeline(), id)).filter((f) => f && f.track.kind === 'visual' && !f.track.locked && f.clip.start <= t && clipEnd(f.clip) > t)
        const clip = selected.at(-1)?.clip ?? a.timeline().tracks.filter((tr) => tr.kind === 'visual' && !tr.hidden && !tr.locked).reverse().flatMap((tr) => tr.clips.filter((c) => c.start <= t && clipEnd(c) > t))[0]
        if (clip) a.edit.freezeFrame(clip.id, t)
      }, locations: ['app/timeline', 'clip/context'] }
    ]
    for (const [index, { key, locations, ...command }] of commands.entries()) {
      ctx.commands.register({ category: 'Edit', ...command })
      if (key) ctx.keybindings.register({ id: `${command.id}:key`, key, command: command.id })
      for (const location of locations ?? []) ctx.menus.register({
        id: `${location}:${command.id}`, location, order: location === 'app/edit' ? 45 + index : 160 + index, command: command.id, label: command.title, icon: command.icon, shortcut: key, group: command.id.startsWith('edit.') ? 'clipboard' : 'editing',
        checked: command.id === 'timeline.toggleRippleMode' ? (a) => !!a.settings.get<boolean>('timeline.rippleMode') : undefined
      })
    }
  }
})
