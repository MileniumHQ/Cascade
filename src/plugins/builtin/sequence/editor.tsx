import { definePlugin } from '@core/plugin-api'
import { solidMount } from '../solid'
import { TIMELINE_MIME, TimelineSources } from './TimelineSources'

/** Sources panel "Timelines" list and drag-to-timeline handling for the sequence plugin. Editor only. */
export const sequenceEditorPlugin = definePlugin({
  id: 'cascade.media.sequence.editor', name: 'Sequence editing UI', dependsOn: ['cascade.media.sequence'],
  activate(ctx) {
    ctx.sourceSections.register({ id: 'timelines', order: 10, mount: solidMount(TimelineSources) })
    ctx.timelineDrops.register({
      id: 'sequence', accepts: dt => dt.types.includes(TIMELINE_MIME),
      drop: (app, dt, target) => { app.run('sequence.add', dt.getData(TIMELINE_MIME), target.start, target.trackId) }
    })
  }
})
