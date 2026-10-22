import { describe, expect, it } from 'vitest'
import { createProject, type Clip } from '@shared/project'
import { revalidate, snapshotTargets } from './stale'

const clip = (id: string): Clip => ({ id, type: 'audio', name: id, mediaId: 'm', start: 0, duration: 100, sourceIn: 0, properties: [], data: {} })
const span = (c: Clip) => ({ lo: c.sourceIn, hi: c.sourceIn + c.duration })
function setup() {
  const project = createProject('p'), track = project.timelines[project.activeTimeline].tracks.find((t) => t.kind === 'audio')!
  track.clips = [clip('a')]
  const snapshot = snapshotTargets(project, [{ clip: track.clips[0], track }], span)[0]
  return { project, track, snapshot }
}
const edited = (project: ReturnType<typeof setup>['project'], fn: (t: ReturnType<typeof setup>['track']) => void) => {
  const next = structuredClone(project)
  fn(next.timelines[next.activeTimeline].tracks.find((t) => t.kind === 'audio')!)
  return next
}

describe('stale-target revalidation', () => {
  it('accepts an unchanged target', () => {
    const { project, snapshot } = setup()
    expect(revalidate(structuredClone(project), snapshot, span)).toMatchObject({ clip: { id: 'a' } })
  })
  it.each([
    ['removed', (t: any) => { t.clips = [] }, 'removed'],
    ['locked', (t: any) => { t.locked = true }, 'locked'],
    ['trimmed', (t: any) => { t.clips[0].sourceIn = 10 }, 'edited'],
    ['moved', (t: any) => { t.clips[0].start = 10 }, 'edited'],
    ['property edited', (t: any) => { t.clips[0].properties = [{ id: 'p', type: 'volume', enabled: true, params: { gain: { value: -6 } } }] }, 'edited']
  ])('rejects a clip that was %s', (_name, change, reason) => {
    const { project, snapshot } = setup()
    expect(String(revalidate(edited(project, change), snapshot, span))).toContain(reason)
  })
  it('rejects another timeline, another project and a changed source span', () => {
    const { project, snapshot } = setup()
    expect(revalidate({ ...structuredClone(project), id: 'other' }, snapshot, span)).toBe('the project or timeline changed')
    expect(revalidate({ ...structuredClone(project), activeTimeline: 'elsewhere' }, snapshot, span)).toBe('the project or timeline changed')
    expect(revalidate(structuredClone(project), snapshot, (c) => ({ lo: c.sourceIn, hi: c.sourceIn + 2 * c.duration }))).toContain('source range')
  })
})
