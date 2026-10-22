import { describe, expect, it } from 'vitest'
import {
  childFolders, createFolder, deleteFolder, emptyBin, folderOf, mediaIn, moveFolder, moveMedia, pathTo, readBin, renameFolder, uniqueName, writeBin, type Bin
} from './folders'

const build = (): Bin => {
  let b = emptyBin()
  b = createFolder(b, 'a', 'Interviews', null)
  b = createFolder(b, 'b', 'Day 1', 'a')
  b = createFolder(b, 'c', 'B-roll', null)
  return moveMedia(b, ['m1', 'm2'], 'b')
}

describe('bin folders', () => {
  it('lists children by name and builds the breadcrumb', () => {
    const b = build()
    expect(childFolders(b, null).map((f) => f.name)).toEqual(['B-roll', 'Interviews'])
    expect(pathTo(b, 'b').map((f) => f.id)).toEqual(['a', 'b'])
    expect(pathTo(b, null)).toEqual([])
    expect(pathTo(b, 'missing')).toEqual([])
  })
  it('places media and falls back to the root', () => {
    let b = build()
    expect(folderOf(b, 'm1')).toBe('b')
    expect(folderOf(b, 'm9')).toBeNull()
    expect(mediaIn(b, null, ['m1', 'm2', 'm3'])).toEqual(['m3'])
    expect(mediaIn(b, 'a', ['m1', 'm2', 'm3'])).toEqual([])
    expect(mediaIn(b, 'a', ['m1', 'm2', 'm3'], true)).toEqual(['m1', 'm2'])
    b = moveMedia(b, ['m1'], null)
    expect(folderOf(b, 'm1')).toBeNull()
    expect(folderOf(moveMedia(b, ['m1'], 'nope'), 'm1')).toBeNull()
  })
  it('deleting a folder moves its contents to the parent', () => {
    const b = deleteFolder(build(), 'a')
    expect(b.folders.map((f) => [f.id, f.parent])).toEqual([['b', null], ['c', null]])
    expect(folderOf(b, 'm1')).toBe('b')
    const inner = deleteFolder(build(), 'b')
    expect(folderOf(inner, 'm1')).toBe('a')
    expect(deleteFolder(build(), 'nope')).toEqual(build())
  })
  it('renames and refuses empty names', () => {
    expect(renameFolder(build(), 'c', ' Cutaways ').folders.find((f) => f.id === 'c')?.name).toBe('Cutaways')
    const b = build()
    expect(renameFolder(b, 'c', '  ')).toBe(b)
  })
  it('moves folders but never into themselves', () => {
    const b = build()
    expect(moveFolder(b, 'c', 'a').folders.find((f) => f.id === 'c')?.parent).toBe('a')
    expect(moveFolder(b, 'a', 'b')).toBe(b)
    expect(moveFolder(b, 'a', 'a')).toBe(b)
    expect(moveFolder(b, 'b', null).folders.find((f) => f.id === 'b')?.parent).toBeNull()
  })
  it('picks unique names among siblings', () => {
    let b = createFolder(emptyBin(), 'x', 'New folder', null)
    expect(uniqueName(b, null)).toBe('New folder 2')
    b = createFolder(b, 'y', uniqueName(b, null), null)
    expect(uniqueName(b, null)).toBe('New folder 3')
    expect(uniqueName(b, 'x')).toBe('New folder')
    expect(uniqueName(b, null, 'New folder', 'x')).toBe('New folder')
  })
  it('reads damaged data safely and keeps extra keys on write', () => {
    expect(readBin(undefined)).toEqual(emptyBin())
    expect(readBin('x')).toEqual(emptyBin())
    const b = readBin({
      folders: [{ id: 'a', name: 'A', parent: 'ghost' }, { id: 'b', name: 'B', parent: 'c' }, { id: 'c', name: 'C', parent: 'b' }, { id: 'a', name: 'dup' }, { name: 'no id' }],
      placement: { m1: 'a', m2: 'ghost', m3: 5 }
    })
    expect(b.folders.map((f) => [f.id, f.parent])).toEqual([['a', null], ['b', null], ['c', 'b']])
    expect(b.placement).toEqual({ m1: 'a' })
    expect(writeBin({ extra: 1, folders: [] }, b)).toMatchObject({ extra: 1, folders: b.folders, placement: b.placement })
  })
})
