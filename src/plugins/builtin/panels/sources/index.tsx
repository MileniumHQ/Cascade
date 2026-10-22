import { definePlugin, type PanelContext } from '@core/plugin-api'
import { Button, IconButton, Segmented } from '@ui/kit'
import { solidMount } from '../../solid'
import { Sources } from './Sources'
import { newFolder } from './bin'
import { importState, setViewMode, trackImport, viewMode } from './state'
import './sources.css'

/** Header buttons: Import + grid/list toggle. */
function Actions(props: { ctx: PanelContext }) {
  const app = props.ctx.app
  return (
    <>
      <Button size="sm" icon={importState().jobs > 0 ? 'loader-circle' : 'plus'} class={importState().jobs > 0 ? 'sc-import-btn busy' : 'sc-import-btn'} tip="Import media" kbd="Ctrl+I" onClick={() => void trackImport(app, () => app.run('media.import'))}>
        Import
      </Button>
      <IconButton icon="folder" tip="New folder" onClick={() => app.run('sources.newFolder')} />
      <Segmented
        value={viewMode()}
        onChange={setViewMode}
        options={[
          { value: 'grid', icon: 'layout-grid', tip: 'Grid view' },
          { value: 'list', icon: 'list', tip: 'List view' }
        ]}
      />
    </>
  )
}

export const sourcesPlugin = definePlugin({
  id: 'cascade.panels.sources',
  name: 'Sources panel',
  activate(ctx) {
    ctx.commands.register({ id: 'sources.newFolder', title: 'New bin folder', icon: 'folder', category: 'Media', run: (a) => newFolder(a) })
    ctx.panels.register({
      id: 'sources',
      title: 'Sources',
      icon: 'folder-open',
      region: 'side',
      mount: solidMount(Sources),
      actions: solidMount(Actions)
    })
  }
})
