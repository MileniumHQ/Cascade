import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, findClip, type Clip, type Project } from '@shared/project'
import { FLICKS as S } from '@shared/time'
import { captureClips, parseClipboard, pasteClips } from './clipboard'
import { CascadeApp } from './app'
const clip = (id: string, start: number, linkId?: string): Clip => ({ id, type: 'unknown-video', name: id, start, duration: 2 * S, sourceIn: S, mediaId: 'media', linkId, properties: [{ id: 'prop', type: 'unknown-property', enabled: true, params: { x: { value: 2, keyframes: [{ id: 'kf', t: S, value: 3, easing: { id: 'unknown-ease' } }] } } }], data: { nested: { a: [1, 2] } } })
function source(): Project {
  const p = createProject('Source'), tl = p.timelines[p.activeTimeline]
  tl.tracks[2].clips = [clip('v3', 3 * S, 'L')]
  tl.tracks[0].clips = [clip('v1', 5 * S)]
  tl.tracks[3].clips = [clip('a1', 3 * S, 'L')]
  p.media.media = { id: 'media', name: 'footage', type: 'unknown-video', path: '/footage.mov', meta: { duration: 20 * S } }
  p.mediaOrder.push('media')
  return p
}
afterEach(() => vi.unstubAllGlobals())
describe('clipboard payload', () => {
  it('deep-copies linked clips, relative times and offsets within each track kind', () => {
    const p = source(), payload = captureClips(p, ['v3', 'v1'])!
    expect(payload.clips.map((e) => [e.clip.id, e.clip.start, e.kind, e.trackOffset])).toEqual([['v3', 0, 'visual', 0], ['v1', 2 * S, 'visual', 2], ['a1', 0, 'audio', 0]])
    payload.clips[0].clip.properties[0].params.x.value = 99
    expect(findClip(p.timelines[p.activeTimeline], 'v3')!.clip.properties[0].params.x.value).toBe(2)
    expect(parseClipboard(JSON.stringify(payload))).toEqual(payload)
    expect(captureClips(p, [])).toBeNull()
  })
  it('rejects foreign, malformed or unsupported text', () => {
    for (const text of ['', 'null', '{}', '{"cascade":"clips","version":2}', '{"cascade":"clips","version":1,"clips":[],"media":[]}']) expect(parseClipboard(text)).toBeNull()
    const payload = captureClips(source(), ['v3'])!
    payload.clips[0].clip.duration = NaN
    expect(parseClipboard(JSON.stringify(payload))).toBeNull()
  })
  it('pastes across projects, creates offset tracks and deduplicates media by path', () => {
    const payload = captureClips(source(), ['v3', 'v1'])!, p = createProject('Target'), tl = p.timelines[p.activeTimeline]
    const target = tl.tracks[0]
    p.media.existing = { ...payload.media[0], id: 'existing' }
    p.mediaOrder.push('existing')
    const ids = pasteClips(p, payload, 10 * S, target.id)!
    expect(ids).toHaveLength(3)
    expect(tl.tracks.filter((t) => t.kind === 'visual')).toHaveLength(5)
    const clips = ids.map((id) => findClip(tl, id)!.clip)
    expect(clips.map((c) => c.start)).toEqual([10 * S, 12 * S, 10 * S])
    expect(clips.every((c) => c.mediaId === 'existing')).toBe(true)
    expect(Object.keys(p.media)).toHaveLength(1)
    expect(clips[0].linkId).toBe(clips[2].linkId)
    expect(clips[0].linkId).not.toBe('L')
    expect(clips[0].properties[0].id).not.toBe(payload.clips[0].clip.properties[0].id)
    expect(clips[0].properties[0].params.x.keyframes![0].id).not.toBe('kf')
    const second = pasteClips(p, payload, 20 * S, target.id)!
    expect(findClip(tl, second[0])!.clip.linkId).not.toBe(clips[0].linkId)
    expect(new Set([...ids, ...second]).size).toBe(6)
  })
  it('imports missing media once and never aliases a conflicting media id', () => {
    const p = createProject('Target'), payload = captureClips(source(), ['v3'])!
    p.media.media = { ...payload.media[0], path: '/different.mov' }
    const ids = pasteClips(p, payload, 0)!
    const id = findClip(p.timelines[p.activeTimeline], ids[0])!.clip.mediaId!
    expect(id).not.toBe('media')
    expect(p.media[id].path).toBe('/footage.mov')
    pasteClips(p, payload, 4 * S)
    expect(Object.keys(p.media)).toHaveLength(2)
  })
  it('overwrites on paste and splits a straddling clip for insert paste', () => {
    const payload = captureClips(source(), ['v1'])!, p = createProject('Target'), tl = p.timelines[p.activeTimeline], track = tl.tracks[0]
    track.clips = [{ ...clip('existing', 0), duration: 10 * S, mediaId: undefined }]
    const ids = pasteClips(p, payload, 3 * S, track.id)!
    expect(track.clips.map((c) => [c.start, c.duration])).toEqual([[0, 3 * S], [3 * S, 2 * S], [5 * S, 5 * S]])
    const insert = pasteClips(p, payload, S, track.id, true)!
    expect(findClip(tl, ids[0])!.clip.start).toBe(5 * S)
    expect(findClip(tl, insert[0])!.clip.start).toBe(S)
    expect(track.clips.at(-1)!.start + track.clips.at(-1)!.duration).toBe(12 * S)
  })
  it('refuses locked target/linked insertion without importing media or partially editing', () => {
    const p = source(), tl = p.timelines[p.activeTimeline], payload = captureClips(p, ['v1'])!
    tl.tracks[3].locked = true
    const before = JSON.stringify(p)
    expect(pasteClips(p, payload, 4 * S, tl.tracks[2].id, true)).toBeNull()
    expect(JSON.stringify(p)).toBe(before)
    tl.tracks[0].locked = true
    expect(pasteClips(p, payload, 4 * S, tl.tracks[0].id)).toBeNull()
  })
  it('uses tagged OS clipboard JSON to paste between independent windows and ignores foreign text', async () => {
    let text = ''
    vi.stubGlobal('navigator', { clipboard: { writeText: async (s: string) => { text = s }, readText: async () => text } })
    const from = new CascadeApp('editor', null, source()), to = new CascadeApp('editor', null)
    from.selection.setClips(['v3'])
    await from.clipboard.copy()
    expect(JSON.parse(text).cascade).toBe('clips')
    const ids = await to.clipboard.paste()
    expect(ids).toHaveLength(2)
    expect(Object.values(to.project().media)[0].path).toBe('/footage.mov')
    text = 'a foreign application copied this'
    const before = JSON.stringify(to.project())
    expect(await to.clipboard.paste()).toEqual([])
    expect(JSON.stringify(to.project())).toBe(before)
  })
  it('service selects paste results, advances playhead and undoes the entire paste once', async () => {
    const app = new CascadeApp('editor', null, source())
    app.selection.setClips(['v3'])
    await app.clipboard.copy()
    app.playback.seek(10 * S)
    const before = JSON.stringify(app.project())
    const ids = await app.clipboard.paste(true)
    expect(ids).toHaveLength(2)
    expect(app.selection.clips.get()).toEqual(ids)
    expect(app.playback.time.get()).toBe(12 * S)
    app.doc.undo()
    expect(JSON.stringify(app.project())).toBe(before)
    expect(app.doc.canUndo).toBe(false)
  })
})
