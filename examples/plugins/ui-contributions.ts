/**
 * Example: the framework-agnostic UI contribution points. Every `mount(el, ctx)` gets a plain DOM
 * element and returns an optional cleanup, so any UI library (or none) works. Markers, transition
 * chips, the Timelines list and the path handles are built on exactly these.
 *
 *  - timelineDecorations: draw on the ruler, a track lane or a clip body
 *  - snapTargets:         extra snap points for timeline drags
 *  - timelineMenus:       items at the top of the clip / lane context menus
 *  - timelineDrops:       handle custom drags dropped on the timeline
 *  - inspectorSections:   extra sections under a clip, or an inspector for another selection kind
 *  - sourceSections / sourceItemDecorations: the Sources panel
 *  - overlays + claimInput: preview overlays that take over pointer input from the transform gizmo
 */
import type { PluginDefinition } from '../../src/core/plugin-api'

const FLICKS = 705_600_000
const NOTE_MIME = 'application/x-example-note'

const plugin: PluginDefinition = {
  id: 'example.ui-contributions',
  name: 'UI contribution examples',
  activate(ctx) {
    // A tick every 10 s on the ruler. `ctx.x(t)` is a pixel offset from the left of the ruler lane;
    // `ctx.subscribe` fires on zoom, scroll, resize and edits.
    ctx.timelineDecorations.register({
      id: 'example.ticks',
      target: 'ruler',
      mount(el, view) {
        const draw = () => {
          const { start, end } = view.range()
          const frag = document.createDocumentFragment()
          for (let t = Math.ceil(start / (10 * FLICKS)) * 10 * FLICKS; t < end; t += 10 * FLICKS) {
            const tick = document.createElement('i')
            tick.style.cssText = `position:absolute;bottom:0;width:1px;height:6px;background:#82cbff;left:${view.x(t)}px`
            frag.append(tick)
          }
          el.replaceChildren(frag)
        }
        draw()
        return view.subscribe(draw)
      }
    })

    // The same 10 s grid as snap points (clip edges, the playhead and markers snap too).
    ctx.snapTargets.register({
      id: 'example.grid',
      points(app) {
        const out: number[] = []
        for (let t = 0; t <= app.duration(); t += 10 * FLICKS) out.push(t)
        return out
      }
    })

    // Right-click a clip → an extra entry above the built-in ones.
    ctx.timelineMenus.register({
      id: 'example.copyName',
      target: 'clip',
      items: (app, hit) => [{ label: 'Copy clip name', icon: 'copy', run: () => void navigator.clipboard.writeText(app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === hit.clipId)?.name ?? '') }]
    })

    // Drops carrying NOTE_MIME become a marker at the drop point. `accepts` only sees `types`;
    // read `getData` synchronously inside `drop`, before any await.
    ctx.timelineDrops.register({
      id: 'example.noteDrop',
      accepts: (dt) => dt.types.includes(NOTE_MIME),
      drop(app, dt, target) {
        app.edit.addMarker(target.start, dt.getData(NOTE_MIME) || 'Note')
      }
    })

    // `subject: 'clip'` sections append under the focused clip's property cards.
    ctx.inspectorSections.register({
      id: 'example.clipSeconds',
      subject: 'clip',
      mount(el, section) {
        const draw = () => {
          const clip = section.app.timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === section.ids()[0])
          el.textContent = clip ? `Length: ${(clip.duration / FLICKS).toFixed(2)} s` : ''
        }
        draw()
        return section.subscribe(draw)
      }
    })
    // Any other subject needs `selection`: shown when that selection holds ids.
    ctx.inspectorSections.register({
      id: 'example.markerInfo',
      subject: 'marker',
      selection: (app) => app.selection.markers,
      mount(el, section) {
        el.textContent = `${section.ids().length} marker(s) selected`
      }
    })

    ctx.sourceSections.register({
      id: 'example.sourceNote',
      mount(el) {
        el.textContent = 'Drag me onto the timeline to drop a marker'
        el.draggable = true
        el.ondragstart = (e) => e.dataTransfer?.setData(NOTE_MIME, 'Dropped note')
      }
    })
    ctx.sourceItemDecorations.register({
      id: 'example.typeBadge',
      mount(el, item) {
        const badge = document.createElement('span')
        badge.style.cssText = 'position:absolute;top:4px;left:4px;font-size:9px;opacity:.8'
        badge.textContent = item.media()?.type ?? ''
        el.append(badge)
        return () => badge.remove()
      }
    })

    // An overlay that owns the pointer while it is "armed": the transform gizmo yields meanwhile.
    ctx.overlays.register({
      id: 'example.armed',
      name: 'Example overlay',
      defaultEnabled: false,
      mount(el, overlay) {
        const button = document.createElement('button')
        button.style.cssText = 'position:absolute;top:8px;right:8px;pointer-events:auto'
        let release: (() => void) | undefined
        const label = () => (button.textContent = release ? 'Release input' : 'Claim input')
        button.onclick = () => {
          if (release) (release(), (release = undefined))
          else release = overlay.claimInput()
          label()
        }
        label()
        el.append(button)
        return () => (release?.(), button.remove())
      }
    })
  }
}

export default plugin
