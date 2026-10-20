import { createResource, createSignal, For, Show } from 'solid-js'
import type { CascadeApp } from '@core/app'
import type { FrameRate } from '@shared/time'
import logo from '../assets/logo.svg'
import { Icon } from '../ui/icon'
import { Button, Modal, TextField } from '../ui/kit'
import type { Session } from './session'
import { FormatPicker } from './ProjectSettings'

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}

export function Home(props: { app: CascadeApp; session: Session }) {
  const { app, session } = props
  const [recent, { refetch }] = createResource(() => app.host!.projects.recent())
  const [creating, setCreating] = createSignal(false)

  return (
    <main class="home">
      <div class="home-inner">
        <section class="home-hero">
          <img src={logo} alt="" class="home-logo" draggable={false} />
          <h1>Cascade</h1>
        </section>

        <section class="home-actions">
          <button class="home-card primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            <b>New project…</b>
          </button>
          <button class="home-card" onClick={() => void session.openDialog()}>
            <Icon name="folder-open" size={16} />
            <b>Open project…</b>
          </button>
        </section>

        <section class="home-recent">
          <header>
            <h2>Recent</h2>
          </header>
          <Show when={recent()?.length} fallback={<div class="home-empty">No recent projects</div>}>
            <div class="recent-list">
              <For each={recent()}>
                {(r) => (
                  <div class="recent-row" onClick={() => void session.open(r.path)}>
                    <div class="recent-icon">
                      <Icon name="clapperboard" size={15} />
                    </div>
                    <div class="recent-meta">
                      <b>{r.name}</b>
                      <span>{r.path}</span>
                    </div>
                    <span class="recent-time">{ago(r.openedAt)}</span>
                    <button
                      class="recent-remove"
                      data-tip="Remove from list"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await app.host!.projects.removeRecent(r.path)
                        void refetch()
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
      <Show when={creating()}>
        <NewProjectModal session={session} onClose={() => setCreating(false)} />
      </Show>
    </main>
  )
}

function NewProjectModal(props: { session: Session; onClose: () => void }) {
  const [name, setName] = createSignal('Untitled')
  const [fmt, setFmt] = createSignal<{ width: number; height: number; fps: FrameRate }>({ width: 1920, height: 1080, fps: { num: 30, den: 1 } })
  const [busy, setBusy] = createSignal(false)
  const create = async () => {
    setBusy(true)
    try {
      await props.session.newProject(name().trim() || 'Untitled', fmt())
      props.onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="New project"
      icon="plus"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="arrow-right" disabled={busy()} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div class="field-row">
        <label>Name</label>
        <TextField value={name()} onChange={setName} onInput={setName} autofocus />
      </div>
      <FormatPicker {...fmt()} onChange={setFmt} />
    </Modal>
  )
}
