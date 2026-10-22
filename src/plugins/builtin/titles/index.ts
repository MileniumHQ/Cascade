import { definePlugin } from '@core/plugin-api'
import { titleGenerators } from './templates'

/** Title templates: ordinary element clips (text, fill, corners, shadow…) with entry/exit animation, listed under "Titles" in Sources. */
export const titlesPlugin = definePlugin({
  id: 'cascade.titles',
  name: 'Titles',
  dependsOn: ['cascade.media.element', 'cascade.properties.text', 'cascade.properties.visual'],
  activate(ctx) {
    for (const g of titleGenerators()) ctx.generators.register(g)
  }
})
