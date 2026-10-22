import { describe, expect, it } from 'vitest'
import { CascadeApp } from './app'

const audioTrack = (app: CascadeApp) => app.timeline().tracks.find((t) => t.kind === 'audio')!

describe('track mixing fields', () => {
  it('stores gain, pan and solo and drops defaults', () => {
    const app = new CascadeApp('editor', null)
    const id = audioTrack(app).id
    app.edit.updateTrack(id, { gain: -6, pan: 0.5, solo: true })
    expect(audioTrack(app)).toMatchObject({ gain: -6, pan: 0.5, solo: true })
    app.edit.updateTrack(id, { gain: 0, pan: 0, solo: false })
    const t = audioTrack(app)
    expect('gain' in t || 'pan' in t || 'solo' in t).toBe(false)
  })
  it('a fader drag is one undo step', () => {
    const app = new CascadeApp('editor', null)
    const id = audioTrack(app).id
    app.edit.updateTrack(id, { gain: -1 }, { gesture: 'start' })
    for (const g of [-2, -3, -4]) app.edit.updateTrack(id, { gain: g }, { gesture: 'update' })
    app.edit.updateTrack(id, { gain: -5 }, { gesture: 'end' })
    expect(audioTrack(app).gain).toBe(-5)
    app.doc.undo()
    expect(audioTrack(app).gain).toBeUndefined()
    expect(app.doc.canUndo).toBe(false)
  })
  it('gain and pan drags stay separate undo steps', () => {
    const app = new CascadeApp('editor', null)
    const id = audioTrack(app).id
    app.edit.updateTrack(id, { gain: -3 }, { gesture: 'start' })
    app.edit.updateTrack(id, { gain: -4 }, { gesture: 'end' })
    app.edit.updateTrack(id, { pan: 0.4 }, { gesture: 'start' })
    app.edit.updateTrack(id, { pan: 0.6 }, { gesture: 'end' })
    app.doc.undo()
    expect(audioTrack(app)).toMatchObject({ gain: -4 })
    expect(audioTrack(app).pan).toBeUndefined()
  })
})
