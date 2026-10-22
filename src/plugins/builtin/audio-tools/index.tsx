import type { CascadeAPI } from '@core/app'
import { definePlugin } from '@core/plugin-api'
import { findClip, type Clip, type Id, type Track } from '@shared/project'
import { FLICKS } from '@shared/time'
import { LoudnessMeter, formatDb } from '@shared/loudness'
import { buildIndex, type Analyses } from '@core/transcript-index'
import { duckKeyframes, speechSegments } from '@shared/ducking'
import { askDuck, askNormalizeTarget } from './dialogs'
import { inOneStep } from './batch'
import { clipSource } from '@core/audio-source'
import { audioTargets, normalizedVolume } from './normalize'
import { revalidate, snapshotTargets, type TargetSnapshot } from './stale'
import { sourceSpan } from '@core/time-remap'

/** Clip ids a clip-level command acts on: the selection when the clicked clip is part of it, else the clip itself. */
function targetIds(app: CascadeAPI, arg: unknown): Id[] {
  const selected = app.selection.clips.get()
  if (typeof arg === 'string') return selected.includes(arg) ? selected : [arg]
  return selected
}

const targetsOf = (app: CascadeAPI, ids: readonly Id[]) => audioTargets(app.timeline(), ids, (t) => t.kind === 'audio')
/** Source range a clip plays now (speed, trim and the linked partner's remap included). */
const spanOf = (app: CascadeAPI) => (clip: Clip) => sourceSpan(clip, app.edit.timeMap(clip))
/** Targets that are still valid after dialogs, decoding and analysis; the rest are reported and dropped. */
function stillValid(app: CascadeAPI, snapshots: TargetSnapshot[], notes: string[]) {
  const span = spanOf(app), fresh = new Map<Id, { clip: Clip; track: Track }>()
  for (const snapshot of snapshots) {
    const live = revalidate(app.project(), snapshot, span)
    if (typeof live === 'string') notes.push(`${snapshot.clip.name}: ${live}, skipped`)
    else fresh.set(snapshot.clip.id, live)
  }
  return fresh
}
const hasAudioTarget = (app: CascadeAPI, arg: unknown) => targetsOf(app, targetIds(app, arg)).length > 0

async function normalizeClips(app: CascadeAPI, arg?: unknown) {
  const targets = targetsOf(app, targetIds(app, arg))
  if (!targets.length) return void app.notify('info', 'Select audio clips to normalize')
  if (!app.host) return void app.notify('error', 'Normalizing needs the desktop app')
  const snapshots = snapshotTargets(app.project(), targets, spanOf(app))
  const target = await askNormalizeTarget(app.settings.get<number>('audio.normalizeTarget'), targets.length)
  if (target === null) return
  app.settings.set('audio.normalizeTarget', target)
  app.notify('info', `Measuring ${targets.length} clip${targets.length === 1 ? '' : 's'}…`)
  const notes: string[] = []
  const changes: { clipId: Id; before: number; after: number }[] = []
  for (const { clip, track } of targets) {
    const volume = clip.properties.find((p) => p.type === 'volume')
    if (track.locked) {
      notes.push(`${clip.name}: track locked`)
      continue
    }
    if (volume?.params.gain?.keyframes?.length) {
      notes.push(`${clip.name}: volume is keyframed`)
      continue
    }
    const src = await clipSource(app, clip)
    const level = src && new LoudnessMeter(src.data, src.rate).measure().integrated
    if (level === null || level === undefined || !Number.isFinite(level)) {
      notes.push(`${clip.name}: silent or no source audio`)
      continue
    }
    const before = Number(volume?.params.gain?.value ?? 0)
    const after = normalizedVolume(level, target)
    if (after !== before) changes.push({ clipId: clip.id, before, after })
    notes.push(`${clip.name}: ${formatDb(level)} LUFS, volume ${before} → ${after} dB`)
  }
  // Measuring is slow; skip clips that were removed, locked or edited meanwhile.
  const fresh = stillValid(app, snapshots.filter((s) => changes.some((c) => c.clipId === s.clip.id)), notes)
  const current = changes.filter((c) => fresh.has(c.clipId))
  if (!current.length) return void app.notify('info', 'Nothing to normalize', notes.join('\n'))
  await inOneStep(app, `Normalize to ${target} LUFS`, (scratch) => {
    for (const c of current) {
      const found = findClip(scratch.timeline(), c.clipId)
      if (!found) continue
      const propId = found.clip.properties.find((p) => p.type === 'volume')?.id ?? scratch.edit.addProperty(c.clipId, 'volume')
      if (propId) scratch.edit.setParam(c.clipId, propId, 'gain', c.after, { at: 0 })
    }
  })
  app.notify('success', `Normalized ${current.length} clip${current.length === 1 ? '' : 's'} to ${target} LUFS`, notes.join('\n'))
}

/** Cached source analyses for every file-backed source (nothing is computed). */
async function cachedAnalyses(app: CascadeAPI): Promise<Analyses> {
  const out: Analyses = new Map()
  const bridge = app.host?.analysis
  if (!bridge) return out
  const paths = [...new Set(Object.values(app.project().media).map((m) => m.path).filter((p): p is string => !!p))]
  await Promise.all(paths.map(async (path) => out.set(path, await bridge.cached(path))))
  return out
}

async function autoDuck(app: CascadeAPI, arg?: unknown) {
  const targets = targetsOf(app, targetIds(app, arg))
  if (!targets.length) return void app.notify('info', 'Select the music or ambience clips to duck')
  const bridge = app.host?.analysis
  if (!bridge) return void app.notify('error', 'Auto-duck needs the desktop app')
  const snapshots = snapshotTargets(app.project(), targets, spanOf(app))
  const choice = await askDuck(targets.length)
  if (!choice) return
  const own = new Set(targets.flatMap(({ clip }) => [clip.id, ...app.timeline().tracks.flatMap((t) => t.clips.filter((c) => clip.linkId && c.linkId === clip.linkId).map((c) => c.id))]))
  const analyses = await cachedAnalyses(app)
  const build = () => buildIndex(app.project(), analyses, (c) => app.edit.timeMap(c))
  let index = build()
  // Speech sources nobody analyzed yet: transcribe them (one at a time) so there is speech to duck under.
  const pending = [...new Set(index.unanalyzed.filter((u) => !own.has(u.clip.id) && u.track.kind === 'audio').map((u) => (u.clip.mediaId ? app.project().media[u.clip.mediaId]?.path : undefined)).filter((p): p is string => !!p))]
  if (pending.length && (await bridge.status()).available.includes('speech')) {
    app.notify('info', `Analyzing speech in ${pending.length} source${pending.length === 1 ? '' : 's'}…`)
    for (const path of pending) {
      try {
        analyses.set(path, [...(analyses.get(path) ?? []), await bridge.run(path, { parts: ['speech'] })])
      } catch (e) {
        app.notify('warning', 'Speech analysis failed', String(e))
      }
    }
    index = build()
  }
  const words = index.words.filter((w) => !own.has(w.clipId)).sort((a, b) => a.start - b.start)
  if (!words.length) return void app.notify('error', 'No speech found on the other tracks', 'Analyze the speech sources first (the speech model must be installed).')
  const ms = (v: number) => Math.round((v * FLICKS) / 1000)
  const segments = speechSegments(words, ms(choice.mergeGapMs))
  const skipped: string[] = []
  // Dialogs and speech analysis take a while: duck only the targets that are still what was chosen.
  const fresh = stillValid(app, snapshots, skipped)
  let keys = 0, ducked = 0
  if (fresh.size) await inOneStep(app, `Duck under speech (${choice.amount} dB)`, (scratch) => {
    for (const { clip: original } of fresh.values()) {
      const clip: Clip | undefined = findClip(scratch.timeline(), original.id)?.clip
      if (!clip) continue
      let volume = clip.properties.find((p) => p.type === 'volume')
      if (volume?.params.gain?.keyframes?.length) {
        skipped.push(`${clip.name}: already has volume keyframes`)
        continue
      }
      if (!volume) {
        const id = scratch.edit.addProperty(clip.id, 'volume')
        volume = id ? findClip(scratch.timeline(), clip.id)!.clip.properties.find((p) => p.id === id) : undefined
        if (!volume) continue
      }
      const points = duckKeyframes(segments, clip, Number(volume.params.gain?.value ?? 0), { amount: choice.amount, attack: ms(choice.attackMs), release: ms(choice.releaseMs) })
      for (const p of points) scratch.edit.addKeyframe(clip.id, volume.id, 'gain', p.t, p.v, { id: 'ease-in-out' })
      keys += points.length
      ducked++
    }
  })
  if (!keys) app.notify('warning', 'Nothing ducked', skipped.join('\n') || 'No speech overlaps the selected clips')
  else app.notify('success', `Ducked ${ducked} clip${ducked === 1 ? '' : 's'} under ${segments.length} speech segments`, skipped.join('\n') || undefined)
}

/** Editor-side loudness tools: normalize to a target, duck music under speech. */
export const audioToolsPlugin = definePlugin({
  id: 'cascade.audio-tools',
  name: 'Audio tools',
  activate(ctx) {
    ctx.settings.register({
      id: 'audio.normalizeTarget',
      section: 'Audio',
      label: 'Normalize target',
      description: 'Integrated loudness (LUFS) the Normalize command aims for: -14 online, -16 podcasts, -23 broadcast',
      type: 'number',
      default: -14
    })
    ctx.commands.register({ id: 'audio.normalizeClips', title: 'Normalize loudness…', icon: 'volume-2', category: 'Audio', enabled: (app) => hasAudioTarget(app, undefined), run: (app, arg) => normalizeClips(app, arg) })
    ctx.commands.register({ id: 'audio.autoDuck', title: 'Auto-duck under speech…', icon: 'audio-lines', category: 'Audio', enabled: (app) => hasAudioTarget(app, undefined), run: (app, arg) => autoDuck(app, arg) })
    const when = (app: CascadeAPI, target: unknown) => hasAudioTarget(app, target)
    ctx.menus.register({ id: 'audio.normalize.clip', location: 'clip/context', label: 'Normalize loudness…', icon: 'volume-2', command: 'audio.normalizeClips', when })
    ctx.menus.register({ id: 'audio.duck.clip', location: 'clip/context', label: 'Auto-duck under speech…', icon: 'audio-lines', command: 'audio.autoDuck', when })
    ctx.menus.register({ id: 'audio.normalize.menu', location: 'app/timeline', group: 'audio', command: 'audio.normalizeClips', label: 'Normalize Loudness…', order: 900 })
    ctx.menus.register({ id: 'audio.duck.menu', location: 'app/timeline', group: 'audio', command: 'audio.autoDuck', label: 'Auto-Duck Under Speech…', order: 910 })
  }
})
