import { describe, expect, it } from 'vitest'
import { FLICKS } from '@shared/time'
import { stillFileName, stillFormat } from './still'

describe('still frame names', () => {
  it('uses the timecode without separators the file system dislikes', () => {
    expect(stillFileName('My Film', 12 * FLICKS, { num: 30, den: 1 }, 'png')).toBe('My Film 00-00-12-00.png')
    expect(stillFileName('a/b:c', 0, { num: 30, den: 1 }, 'jpg')).toBe('a-b-c 00-00-00-00.jpg')
    expect(stillFileName('  ', 0, { num: 25, den: 1 }, 'png')).toMatch(/^Untitled 00-00-00-00\.png$/)
  })

  it('picks the format from the extension', () => {
    expect(stillFormat('/x/a.PNG')).toBe('png')
    expect(stillFormat('/x/a.jpg')).toBe('jpeg')
    expect(stillFormat('/x/a.JPEG')).toBe('jpeg')
    expect(stillFormat('/x/a')).toBe('png')
  })
})
