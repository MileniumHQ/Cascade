import { definePlugin } from '@core/plugin-api'
import { solidMount } from '../solid'
import { TransitionInspector } from './Inspector'
import { transitionMenu, Transitions } from './ui'

/** Timeline chips / fade handles, their context menus and the inspector for the transitions plugin. Editor only. */
export const transitionsEditorPlugin = definePlugin({
  id: 'cascade.transitions.editor', name: 'Transition editing UI', dependsOn: ['cascade.transitions'],
  activate(ctx) {
    ctx.timelineDecorations.register({ id: 'transitions', target: 'track', order: 10, mount: solidMount(Transitions) })
    for (const target of ['clip', 'lane'] as const) {
      ctx.timelineMenus.register({ id: `transitions.add.${target}`, target, order: 0, items: (app, hit) => { const item = transitionMenu(app, hit.track, hit.time); return item ? [item] : [] } })
    }
    ctx.inspectorSections.register({
      id: 'transition', subject: 'transition', selection: app => app.selection.transitions,
      // The inspector remounts the section when the selected transition changes.
      mount: (el, section) => solidMount(TransitionInspector)(el, { app: section.app, id: section.ids()[0] })
    })
  }
})
