import { describe, expect, it, vi } from 'vitest'
import type { HostBridge } from '@shared/ipc'
import { createProject, type MediaItem } from '@shared/project'
import { FLICKS } from '@shared/time'
import { CascadeApp, type Notification } from './app'

const item = (id: string, path: string, duration = 10 * FLICKS): MediaItem => ({ id, type: 'video', name: id, path, meta: { duration, width: 1280 }, proxyPath: `/proxy/${id}` })

function setup(existing: Set<string>, probed: Record<string, object> = {}) {
  const host = {
    fs: { existsMany: async (paths: string[]) => paths.map((p) => existing.has(p)) },
    media: { probe: async (path: string) => probed[path] ?? { duration: 10 * FLICKS, width: 1920 } }
  } as unknown as HostBridge
  const project = createProject('T')
  project.media = { a: item('a', '/old/a.mp4'), b: item('b', '/old/b.mp4'), g: { id: 'g', type: 'text', name: 'g', meta: {} } }
  project.mediaOrder = ['a', 'b', 'g']
  const app = new CascadeApp('editor', host, project)
  const notes: Notification[] = []
  app.onNotify.on((n) => notes.push(n))
  return { app, notes }
}

describe('media status', () => {
  it('flags file-backed media whose file is missing and ignores generators', async () => {
    const { app } = setup(new Set(['/old/a.mp4']))
    await app.media.check()
    expect([...app.media.offline.get()]).toEqual(['b'])
    expect(app.media.isOffline('b')).toBe(true)
    expect(app.media.isOffline('g')).toBe(false)
  })
  it('re-checks when the media list changes', async () => {
    const existing = new Set<string>()
    const { app } = setup(existing)
    await app.media.check()
    expect(app.media.offline.get().size).toBe(2)
    existing.add('/new/a.mp4')
    expect(await app.edit.relinkMedia('a', '/new/a.mp4')).toBe(true)
    await vi.waitFor(() => expect([...app.media.offline.get()]).toEqual(['b']))
  })
})

describe('relinkMedia', () => {
  it('updates path and meta, drops the stale proxy, and undoes in one step', async () => {
    const { app } = setup(new Set())
    await app.edit.relinkMediaMany([{ mediaId: 'a', path: '/new/a.mp4' }, { mediaId: 'b', path: '/new/b.mp4' }])
    const a = app.project().media.a
    expect(a.path).toBe('/new/a.mp4')
    expect(a.meta.width).toBe(1920)
    expect(a.proxyPath).toBeUndefined()
    expect(app.project().media.b.path).toBe('/new/b.mp4')
    app.doc.undo()
    expect(app.project().media.a.path).toBe('/old/a.mp4')
    expect(app.project().media.b.path).toBe('/old/b.mp4')
    expect(app.doc.canUndo).toBe(false)
  })
  it('warns when the duration differs and refuses unreadable files', async () => {
    const { app, notes } = setup(new Set(), { '/new/a.mp4': { duration: 20 * FLICKS }, '/new/b.mp4': { error: 'bad file' } })
    expect(await app.edit.relinkMedia('a', '/new/a.mp4')).toBe(true)
    expect(notes.map((n) => n.kind)).toContain('warning')
    expect(await app.edit.relinkMedia('b', '/new/b.mp4')).toBe(false)
    expect(app.project().media.b.path).toBe('/old/b.mp4')
    expect(await app.edit.relinkMedia('missing', '/x.mp4')).toBe(false)
  })
})
