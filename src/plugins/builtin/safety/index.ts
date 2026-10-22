import { definePlugin } from '@core/plugin-api'
import type { Id } from '@shared/project'
import { relinkAllWithDialog, relinkWithDialog } from './relink'

/** Missing-media handling: relink commands and a heads-up when a project opens with offline files. */
export const safetyPlugin = definePlugin({
  id: 'cascade.safety',
  name: 'Project safety',
  activate(ctx) {
    const app = ctx.app
    const anyOffline = () => app.media.offline.get().size > 0

    ctx.commands.register({
      id: 'media.relink',
      title: 'Relink media…',
      icon: 'link',
      category: 'Media',
      enabled: anyOffline,
      run: (a, mediaId?: Id) => relinkWithDialog(a, typeof mediaId === 'string' ? mediaId : undefined)
    })
    ctx.commands.register({
      id: 'media.relinkAll',
      title: 'Relink missing media…',
      icon: 'folder-search',
      category: 'Media',
      enabled: anyOffline,
      run: (a) => relinkAllWithDialog(a)
    })
    ctx.menus.register({ id: 'menu:media.relink', location: 'source/context', command: 'media.relink', label: 'Relink…', icon: 'link', order: 10, when: (a, media) => a.media.isOffline((media as { id?: Id } | undefined)?.id) })
    ctx.menus.register({ id: 'menu:media.relinkAll', location: 'app/file', group: 'media', command: 'media.relinkAll', label: 'Relink Missing Media…', order: 5 })

    // Tell the user once per project (and per newly missing file set) rather than on every focus check.
    const told = new Set<Id>()
    let projectId = app.project().id
    ctx.track(
      app.media.offline.subscribe((offline) => {
        if (app.project().id !== projectId) {
          projectId = app.project().id
          told.clear()
        }
        const fresh = [...offline].filter((id) => !told.has(id))
        for (const id of offline) told.add(id)
        if (fresh.length) app.notify('warning', `${fresh.length} media file${fresh.length === 1 ? ' is' : 's are'} missing`, 'Right-click a source and choose Relink, or use File › Relink Missing Media.')
      })
    )
  }
})
