import { describe, expect, it } from 'vitest'
import type { ExportPresetContribution } from '@core/plugin-api'
import { exportFrameRate, exportFrameRateOptions, listPresets, presetMatches, presetPrefs, sanitizeUserPresets, snapshotPreset, uniquePresetId, type ExportState } from './presets'

const state = (extra: Partial<ExportState> = {}): ExportState => ({
  exporter: 'mp4-h264', options: { quality: 18, preset: 'medium' }, size: { w: 1920, h: 1080 }, sizeIsProject: true,
  fps: { num: 30, den: 1 }, fpsIsProject: true, range: 'all', ...extra
})
const yt: ExportPresetContribution = { id: 'p', name: 'YouTube', exporter: 'mp4-h264', options: { quality: 18 }, size: { width: 1920, height: 1080 } }

describe('export presets', () => {
  it('hides presets whose exporter is missing and lists contributed ones first', () => {
    const user = [{ id: 'user:a', name: 'A', exporter: 'mp4-h264' }, { id: 'user:b', name: 'B', exporter: 'gone' }]
    const list = listPresets([yt, { ...yt, id: 'q', exporter: 'nope' }], user, (id) => id === 'mp4-h264')
    expect(list.map((p) => [p.id, p.user])).toEqual([['p', false], ['user:a', true]])
  })

  it('matches only what the preset sets', () => {
    expect(presetMatches(yt, state())).toBe(true)
    expect(presetMatches(yt, state({ options: { quality: 23 } }))).toBe(false)
    expect(presetMatches(yt, state({ size: { w: 1280, h: 720 } }))).toBe(false)
    expect(presetMatches(yt, state({ exporter: 'webm-vp9' }))).toBe(false)
    expect(presetMatches({ exporter: 'mp4-h264', name: 'x', fps: { num: 60, den: 1 } }, state({ fps: { num: 60, den: 1 }, fpsIsProject: false }))).toBe(true)
  })

  it('snapshots project-following values as open', () => {
    const open = snapshotPreset(' Mine ', state(), 'user:mine')
    expect(open).toMatchObject({ id: 'user:mine', name: 'Mine', exporter: 'mp4-h264', range: 'all' })
    expect(open.size).toBeUndefined()
    expect(open.fps).toBeUndefined()
    const fixed = snapshotPreset('Fixed', state({ sizeIsProject: false, fpsIsProject: false, size: { w: 1080, h: 1920 } }), 'user:fixed')
    expect(fixed.size).toEqual({ width: 1080, height: 1920 })
    expect(fixed.fps).toEqual({ num: 30, den: 1 })
    expect(presetMatches(fixed, state({ sizeIsProject: false, fpsIsProject: false, size: { w: 1080, h: 1920 } }))).toBe(true)
  })

  it('maps a preset to panel prefs, using named resolutions and frame rates when they exist', () => {
    expect(presetPrefs({ ...yt, fps: { num: 24000, den: 1001 } })).toMatchObject({ resolution: '1080p', fps: '23.976', options: { quality: 18 } })
    expect(presetPrefs({ ...yt, size: { width: 640, height: 360 } })).toMatchObject({ resolution: 'custom', custom: { w: 640, h: 360 } })
    expect(presetPrefs({ name: 'x', exporter: 'wav' })).toEqual({ exporter: 'wav', options: {} })
  })

  it('sanitizes stored presets', () => {
    expect(sanitizeUserPresets('x')).toEqual([])
    const ok = sanitizeUserPresets([{ id: 'u', name: ' A ', exporter: 'e', size: { width: 2, height: 2 }, fps: { num: 0, den: 1 }, range: 'bad' }, { id: 5 }, null, { id: 'v', name: '', exporter: 'e' }])
    expect(ok).toEqual([{ id: 'u', name: 'A', exporter: 'e', size: { width: 2, height: 2 } }])
  })

  it('makes unique ids', () => {
    expect(uniquePresetId('My Preset!', [])).toBe('user:my-preset')
    expect(uniquePresetId('My Preset', ['user:my-preset'])).toBe('user:my-preset-2')
    expect(uniquePresetId('???', [])).toBe('user:preset')
  })
})

it('retains arbitrary rational preset frame rates exactly', () => {
  const fps = { num: 1234567, den: 100003 }
  expect(presetPrefs({ name: 'Custom', exporter: 'mp4-h264', fps }).fps).toBe('1234567/100003')
})

it('shows custom rational choices and rejects invalid stored rates', () => {
  expect(exportFrameRate('1234567/100003')).toEqual({ num: 1234567, den: 100003 })
  expect(exportFrameRateOptions('1234567/100003').at(-1)).toEqual({ value: '1234567/100003', label: 'Custom · 1234567/100003 fps' })
  for (const value of ['1/0', '0/1', '-2/3', 'Infinity/1', '1.2/3', '9007199254740992/1']) expect(exportFrameRate(value)).toBeUndefined()
  expect(exportFrameRate('23.976')).toEqual({ num: 24000, den: 1001 })
  expect(presetPrefs({ name: 'Equivalent', exporter: 'mp4-h264', fps: { num: 60, den: 2 } }).fps).toBe('30')
})
