import type { ExportPresetContribution } from '@core/plugin-api'
import { FPS_PRESETS, fpsKey, RESOLUTION_PRESETS } from '@shared/formats'
import type { FrameRate } from '@shared/time'

/** App setting holding the user's saved presets. */
export const USER_PRESETS_SETTING = 'export.userPresets'

/** What a preset sets. Contributed presets and saved ones share this shape. */
export type PresetData = Pick<ExportPresetContribution, 'name' | 'description' | 'icon' | 'exporter' | 'options' | 'size' | 'fps' | 'range'>
export interface UserExportPreset extends PresetData {
  id: string
}
export interface ListedPreset extends PresetData {
  id: string
  /** Saved by the user (can be renamed and deleted). */
  user: boolean
}

/** The export settings a preset reads from and writes to. */
export interface ExportState {
  exporter: string
  /** Option values of the current exporter. */
  options: Record<string, unknown>
  size: { w: number; h: number }
  /** Size follows the project. */
  sizeIsProject: boolean
  fps: FrameRate
  fpsIsProject: boolean
  range: 'all' | 'inout'
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isFps = (v: unknown): v is FrameRate => isRecord(v) && Number.isSafeInteger(v.num) && Number.isSafeInteger(v.den) && (v.num as number) > 0 && (v.den as number) > 0

/** Only well-formed saved presets survive loading. */
export function sanitizeUserPresets(value: unknown): UserExportPreset[] {
  if (!Array.isArray(value)) return []
  const out: UserExportPreset[] = []
  for (const v of value) {
    if (!isRecord(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.exporter !== 'string' || !v.name.trim()) continue
    const size = isRecord(v.size) && Number.isSafeInteger(v.size.width) && Number.isSafeInteger(v.size.height) ? { width: v.size.width as number, height: v.size.height as number } : undefined
    out.push({
      id: v.id,
      name: v.name.trim(),
      exporter: v.exporter,
      ...(isRecord(v.options) ? { options: v.options } : {}),
      ...(size ? { size } : {}),
      ...(isFps(v.fps) ? { fps: { num: v.fps.num, den: v.fps.den } } : {}),
      ...(v.range === 'all' || v.range === 'inout' ? { range: v.range } : {})
    })
  }
  return out
}

/** Contributed presets (whose exporter exists) followed by the user's, in order. */
export function listPresets(contributed: (ExportPresetContribution)[], user: UserExportPreset[], hasExporter: (id: string) => boolean): ListedPreset[] {
  return [
    ...contributed.filter((p) => hasExporter(p.exporter)).map((p): ListedPreset => ({ ...p, user: false })),
    ...user.filter((p) => hasExporter(p.exporter)).map((p): ListedPreset => ({ ...p, user: true }))
  ]
}

const sameFps = (a: FrameRate, b: FrameRate) => a.num * b.den === b.num * a.den

/** True when the current settings are exactly what the preset sets (what it leaves open doesn't matter). */
export function presetMatches(p: PresetData, s: ExportState): boolean {
  if (p.exporter !== s.exporter) return false
  for (const [k, v] of Object.entries(p.options ?? {})) if (JSON.stringify(s.options[k]) !== JSON.stringify(v)) return false
  if (p.size ? s.size.w !== p.size.width || s.size.h !== p.size.height : false) return false
  if (p.fps ? !sameFps(s.fps, p.fps) : false) return false
  if (p.range && p.range !== s.range) return false
  return true
}

/** Capture the current settings as a new saved preset (project-following values stay open). */
export function snapshotPreset(name: string, s: ExportState, id: string): UserExportPreset {
  return {
    id,
    name: name.trim(),
    exporter: s.exporter,
    options: { ...s.options },
    ...(s.sizeIsProject ? {} : { size: { width: s.size.w, height: s.size.h } }),
    ...(s.fpsIsProject ? {} : { fps: { ...s.fps } }),
    range: s.range
  }
}

/** The Export panel preferences a preset implies. */
export interface PresetPrefs {
  exporter: string
  options: Record<string, unknown>
  /** 'project', a RESOLUTION_PRESETS id or 'custom' (then `custom` is the size). */
  resolution?: string
  custom?: { w: number; h: number }
  /** 'project', a FPS_PRESETS value, or an exact num/den rational. */
  fps?: string
  range?: 'all' | 'inout'
}

export function presetPrefs(p: PresetData): PresetPrefs {
  const out: PresetPrefs = { exporter: p.exporter, options: { ...p.options } }
  if (p.size) {
    const known = RESOLUTION_PRESETS.find((r) => r.w === p.size!.width && r.h === p.size!.height)
    out.resolution = known ? known.id : 'custom'
    if (!known) out.custom = { w: p.size.width, h: p.size.height }
  }
  if (isFps(p.fps)) out.fps = FPS_PRESETS.find(f => sameFps(f.fps, p.fps!))?.value ?? `${p.fps.num}/${p.fps.den}`
  if (p.range) out.range = p.range
  return out
}

export const knownFps = (f: FrameRate) => FPS_PRESETS.some((p) => sameFps(p.fps, f))

/** A fresh id for a saved preset, unique among `taken`. */
export function uniquePresetId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'
  let id = `user:${slug}`
  for (let n = 2; used.has(id); n++) id = `user:${slug}-${n}`
  return id
}

/** Decode a stored choice without rounding custom rational frame rates. */
export function exportFrameRate(choice: string): FrameRate | undefined {
  const known = FPS_PRESETS.find(p => p.value === choice)
  if (known) return known.fps
  const match = /^(\d+)\/(\d+)$/.exec(choice)
  if (!match) return
  const fps = { num: Number(match[1]), den: Number(match[2]) }
  return isFps(fps) ? fps : undefined
}
export function exportFrameRateOptions(choice: string): { value: string; label: string }[] {
  const options = FPS_PRESETS.map(p => ({ value: p.value, label: `${p.label} fps` }))
  const fps = exportFrameRate(choice)
  if (fps && !options.some(p => p.value === choice)) options.push({ value: choice, label: `Custom · ${fps.num}/${fps.den} fps` })
  return options
}
