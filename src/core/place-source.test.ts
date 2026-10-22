import { describe, expect, it } from 'vitest'
import { uid, type MediaItem } from '@shared/project'
import { secondsToFlicks } from '@shared/time'
import { CascadeApp } from './app'

const sec = secondsToFlicks

function setup() {
  const app = new CascadeApp('editor', null)
  const stage = { mount: () => ({ update() {}, dispose() {} }) }
  app.registries.mediaTypes.register({ id: 'video', name: 'Video', icon: 'film', color: '#fff', track: 'visual', timeBased: true, linkedAudioType: 'audio', stage }, 't', true)
  app.registries.mediaTypes.register({ id: 'audio', name: 'Audio', icon: 'a', color: '#fff', track: 'audio', timeBased: true, stage }, 't', true)
  app.registries.mediaTypes.register({ id: 'image', name: 'Image', icon: 'i', color: '#fff', track: 'visual', defaultDuration: 4, stage }, 't', true)
  const add = (m: Partial<MediaItem> & Pick<MediaItem, 'type'>) => {
    const item: MediaItem = { id: uid('md_'), name: m.type, meta: {}, ...m }
    app.doc.transact('add', (d) => void ((d.media[item.id] = item), d.mediaOrder.push(item.id)))
    return item.id
  }
  const video = add({ type: 'video', meta: { duration: sec(10), hasAudio: true, hasVideo: true } })
  const image = add({ type: 'image' })
  const track = (kind: 'visual' | 'audio', i = 0) => app.timeline().tracks.filter((t) => t.kind === kind)[i]
  return { app, video, image, track }
}

describe('Editing.placeSource', () => {
  it('overwrites a linked video+audio pair at the playhead as one undo step', () => {
    const { app, video, track } = setup()
    app.playback.seek(sec(2))
    const res = app.edit.placeSource('overwrite', video, { sourceIn: sec(1), sourceOut: sec(4) })
    expect(res).toMatchObject({ start: sec(2), end: sec(5) })
    expect(track('visual').clips[0]).toMatchObject({ start: sec(2), duration: sec(3), sourceIn: sec(1), type: 'video' })
    expect(track('audio').clips[0]).toMatchObject({ start: sec(2), duration: sec(3), sourceIn: sec(1), type: 'audio' })
    expect(track('visual').clips[0].linkId).toBe(track('audio').clips[0].linkId)
    expect(app.selection.clips.get()).toHaveLength(2)
    app.doc.undo()
    expect(track('visual').clips).toHaveLength(0)
    expect(track('audio').clips).toHaveLength(0)
  })

  it('brings no audio when the audio lane is off, and no video when the video lane is off', () => {
    const { app, video, track } = setup()
    app.edit.placeSource('overwrite', video, { lanes: { audio: false } })
    expect(track('visual').clips).toHaveLength(1)
    expect(track('visual').clips[0].linkId).toBeUndefined()
    expect(track('audio').clips).toHaveLength(0)
    app.edit.placeSource('overwrite', video, { lanes: { visual: false }, at: sec(20) })
    expect(track('audio').clips).toHaveLength(1)
    expect(track('audio').clips[0].linkId).toBeUndefined()
    expect(app.edit.placeSource('overwrite', video, { lanes: { visual: false, audio: false } })).toBeNull()
  })

  it('inserts at the timeline in/out, letting the timeline duration win', () => {
    const { app, video, track } = setup()
    app.edit.placeSource('overwrite', video, { at: 0 })
    app.doc.transact('marks', (d) => {
      const tl = d.timelines[d.activeTimeline]
      tl.inPoint = sec(4)
      tl.outPoint = sec(6)
    })
    const res = app.edit.placeSource('insert', video, { sourceIn: sec(0), sourceOut: sec(8) })
    expect(res).toMatchObject({ start: sec(4), end: sec(6), fit: true })
    expect(track('visual').clips.map((c) => [c.start, c.duration])).toEqual([[0, sec(4)], [sec(4), sec(2)], [sec(6), sec(6)]])
    expect(track('audio').clips.map((c) => c.start)).toEqual([0, sec(4), sec(6)])
  })

  it('appends after the end of the target tracks', () => {
    const { app, video, image, track } = setup()
    app.edit.placeSource('overwrite', video, { at: 0 })
    const res = app.edit.placeSource('append', image)
    expect(res).toMatchObject({ start: sec(10), end: sec(14) })
    expect(track('visual').clips[1]).toMatchObject({ start: sec(10), duration: sec(4), type: 'image' })
  })

  it('goes to the targeted tracks and refuses locked ones', () => {
    const { app, video, track } = setup()
    app.selection.targets.set({ visual: track('visual', 1).id, audio: track('audio', 1).id })
    app.edit.placeSource('overwrite', video, { at: 0 })
    expect(track('visual', 1).clips).toHaveLength(1)
    expect(track('audio', 1).clips).toHaveLength(1)
    expect(track('visual', 0).clips).toHaveLength(0)
    app.edit.updateTrack(track('visual', 1).id, { locked: true })
    app.edit.updateTrack(track('audio', 1).id, { locked: true })
    // A locked target is skipped (not redirected to another track): with only that lane on, nothing is placed.
    expect(app.edit.placeSource('overwrite', video, { at: sec(30), lanes: { audio: false } })).toBeNull()
    expect(track('visual', 0).clips).toHaveLength(0)
    // With the other lane's track free, the clip lands there alone and is no longer linked.
    app.selection.targets.set({ visual: track('visual', 1).id })
    const res = app.edit.placeSource('overwrite', video, { at: sec(30) })
    expect(res?.clips).toHaveLength(1)
    expect(track('audio', 0).clips).toHaveLength(1)
    expect(track('audio', 0).clips[0].linkId).toBeUndefined()
  })

  it('takes a marked duration for stills, and clamps a mark past the media end', () => {
    const { app, video, image, track } = setup()
    app.edit.placeSource('overwrite', image, { at: 0, sourceIn: sec(0), sourceOut: sec(7) })
    expect(track('visual').clips[0].duration).toBe(sec(7))
    const res = app.edit.placeSource('overwrite', video, { at: sec(20), sourceIn: sec(8), sourceOut: sec(30) })
    expect(res).toMatchObject({ shortened: false, end: sec(22) })
  })
})
