import { describe, expect, it } from 'vitest'
import { CascadeApp } from '@core/app'
import { uid, type MediaItem } from '@shared/project'
import { secondsToFlicks } from '@shared/time'
import { marksOf } from './marks'
import { SourceMonitor } from './service'

const sec = secondsToFlicks

function setup() {
  const app = new CascadeApp('editor', null)
  const stage = { mount: () => ({ update() {}, dispose() {} }) }
  app.registries.mediaTypes.register({ id: 'video', name: 'Video', icon: 'film', color: '#fff', track: 'visual', timeBased: true, linkedAudioType: 'audio', stage }, 't', true)
  app.registries.mediaTypes.register({ id: 'audio', name: 'Audio', icon: 'a', color: '#fff', track: 'audio', timeBased: true, stage }, 't', true)
  const item: MediaItem = { id: uid('md_'), type: 'video', name: 'clip', meta: { duration: sec(20), hasAudio: true, hasVideo: true } }
  app.doc.transact('add', (d) => void ((d.media[item.id] = item), d.mediaOrder.push(item.id)))
  return { app, mon: new SourceMonitor(app), id: item.id }
}

describe('SourceMonitor', () => {
  it('renders the item through a throwaway one-clip project, leaving the document alone', () => {
    const { app, mon, id } = setup()
    mon.open(id)
    const feed = mon.feed()
    const tl = feed.project().timelines[feed.timelineId()]
    expect(tl.tracks.flatMap((t) => t.clips.map((c) => [t.kind, c.type, c.duration]))).toEqual([['visual', 'video', sec(20)], ['audio', 'audio', sec(20)]])
    expect(mon.duration()).toBe(sec(20))
    expect(mon.item()?.lanes).toEqual({ visual: true, audio: true })
    expect(app.timeline().tracks.every((t) => t.clips.length === 0)).toBe(true)
    expect(feed.primary).toBe(false)
  })

  it('marks at its own playhead and saves them with the project without an undo step', () => {
    const { app, mon, id } = setup()
    mon.open(id)
    mon.playback.seek(sec(3))
    mon.markIn()
    mon.playback.seek(sec(8))
    mon.markOut()
    expect(mon.marks.get()).toEqual({ in: sec(3), out: sec(8) })
    expect(marksOf(app.project(), id)).toEqual({ in: sec(3), out: sec(8) })
    expect(app.doc.undoLabel).not.toBe('Source marks')
    mon.playback.seek(sec(1))
    mon.markOut()
    expect(mon.marks.get()).toEqual({ out: sec(1) })
    mon.clearMarks()
    expect(marksOf(app.project(), id)).toEqual({})
  })

  it('reopens an item at its marked in and closes when the item goes away', () => {
    const { app, mon, id } = setup()
    mon.open(id)
    mon.playback.seek(sec(5))
    mon.markIn()
    mon.close()
    expect(mon.mediaId.get()).toBeNull()
    mon.open(id)
    expect(mon.playback.time.get()).toBe(sec(5))
    app.edit.removeMedia([id])
    expect(mon.mediaId.get()).toBeNull()
    expect(mon.item()).toBeNull()
  })

  it('goes to the marks, and edits use the marks and lanes', () => {
    const { app, mon, id } = setup()
    mon.open(id)
    mon.playback.seek(sec(2))
    mon.markIn()
    mon.playback.seek(sec(6))
    mon.markOut()
    mon.goToIn()
    expect(mon.playback.time.get()).toBe(sec(2))
    mon.goToOut()
    expect(mon.playback.time.get()).toBe(sec(6))
    mon.lanes.set({ visual: true, audio: false })
    const res = app.edit.placeSource('overwrite', id, { sourceIn: mon.marks.get().in, sourceOut: mon.marks.get().out, lanes: mon.lanes.get(), at: sec(10) })
    expect(res).toMatchObject({ start: sec(10), end: sec(14) })
    expect(app.timeline().tracks.flatMap((t) => t.clips).map((c) => c.type)).toEqual(['video'])
  })
})
