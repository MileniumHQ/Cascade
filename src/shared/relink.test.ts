import { describe, expect, it } from 'vitest'
import { baseName, deriveRoots, dirName, findRelinks, remapPath, type RelinkIO } from './relink'

describe('deriveRoots / remapPath', () => {
  it('infers the moved root from shared trailing components', () => {
    const roots = deriveRoots('/mnt/a/proj/clips/x.mp4', '/home/u/proj/clips/x.mp4')!
    expect(roots.from).toEqual(['', 'mnt', 'a'])
    expect(remapPath('/mnt/a/proj/other/y.mov', roots)).toBe('/home/u/proj/other/y.mov')
    expect(remapPath('/mnt/b/proj/y.mov', roots)).toBeNull()
  })
  it('handles a renamed file as a directory move', () => {
    const roots = deriveRoots('/old/dir/a.mp4', '/new/dir2/b.mp4')!
    expect(remapPath('/old/dir/c.mp4', roots)).toBe('/new/dir2/c.mp4')
    expect(remapPath('/old/dir/sub/d.mp4', roots)).toBe('/new/dir2/sub/d.mp4')
  })
  it('moves within a sibling directory', () => {
    const roots = deriveRoots('/a/b/x.mp4', '/a/c/x.mp4')!
    expect(remapPath('/a/b/y.mp4', roots)).toBe('/a/c/y.mp4')
  })
  it('returns null when nothing moved', () => {
    expect(deriveRoots('/a/x.mp4', '/a/x.mp4')).toBeNull()
  })
  it('works on Windows paths, ignoring drive-letter case', () => {
    const roots = deriveRoots('D:\\Footage\\shoot\\a.mp4', 'E:\\Backup\\shoot\\a.mp4')!
    expect(remapPath('d:\\footage\\shoot\\b.mp4', roots)).toBe('E:\\Backup\\shoot\\b.mp4')
  })
  it('does not match a path outside the moved folder or the folder itself', () => {
    const roots = deriveRoots('/a/p/x.mp4', '/b/p/x.mp4')!
    expect(remapPath('/a', roots)).toBeNull()
    expect(remapPath('/ab/p/x.mp4', roots)).toBeNull()
  })
  it('splits names', () => {
    expect(baseName('C:\\x\\y.mp4')).toBe('y.mp4')
    expect(dirName('/x/y/z.mp4')).toBe('/x/y')
  })
})

describe('findRelinks', () => {
  const files = new Set(['/new/proj/b.mp4', '/new/proj/sub/c.mp4'])
  const io: RelinkIO = {
    exists: async (paths) => paths.map((p) => files.has(p)),
    findByName: async (_dir, names) => Object.fromEntries(names.filter((n) => n === 'z.mp4').map((n) => [n, `/new/found/${n}`]))
  }
  it('uses the relative move first, then searches by name', async () => {
    const offline = [
      { id: 'b', path: '/old/proj/b.mp4' },
      { id: 'c', path: '/old/proj/sub/c.mp4' },
      { id: 'z', path: '/elsewhere/z.mp4' },
      { id: 'q', path: '/elsewhere/q.mp4' }
    ]
    const out = await findRelinks(offline, { oldPath: '/old/proj/a.mp4', newPath: '/new/proj/a.mp4' }, '/new/proj', io)
    expect(out).toEqual([
      { id: 'b', path: '/new/proj/b.mp4' },
      { id: 'c', path: '/new/proj/sub/c.mp4' },
      { id: 'z', path: '/new/found/z.mp4' }
    ])
  })
})
