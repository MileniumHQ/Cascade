import '@fontsource-variable/inter/index.css'
import { CascadeApp } from '@core/app'
import { PluginHost, importPluginModule } from '@core/plugin-host'
import type { StageAudio } from '@core/plugin-api'
import { renderPlugins } from '@plugins/builtin'
import { Stage } from '@stage/stage'
import { FLICKS } from '@shared/time'
import type { RenderWorkerJob } from '@shared/ipc'

const bridge = window.cascade.render!
let job: RenderWorkerJob
let app: CascadeApp
let stage: Stage | undefined
let stamp: HTMLCanvasElement
let chain = Promise.resolve()
const stageResources = new WeakMap<Stage, Element[]>()

function fontCss() {
  const rules: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSFontFaceRule) rules.push(rule.cssText.replace(/Inter Variable/g, 'Inter').replace(/url\(["']?([^"')]+)["']?\)/g, (_match, url) => `url("${new URL(url, sheet.href ?? location.href).href}")`))
    }
  }
  return rules.join('\n')
}

function createStage(audio?: StageAudio) {
  const result = new Stage({
    registries: app.registries, document, mode: 'render', mediaUrl: window.cascade.mediaUrl,
    audio, css: fontCss()
  })
  stageResources.set(result, [document.head.lastElementChild!, document.body.lastElementChild!])
  result.root.style.inset = '0 auto auto 0'
  result.root.style.width = `${job.width}px`
  result.root.style.height = `${job.height}px`
  return result
}

function disposeStage(value: Stage) {
  value.dispose()
  for (const element of stageResources.get(value) ?? []) element.remove()
  stageResources.delete(value)
}

async function audioBuffer(context: OfflineAudioContext, mediaId: string, start: number, duration: number) {
  const source = job.pcmSources?.[mediaId]
  if (!source) throw new Error(`Missing PCM for media ${mediaId}`)
  const frames = Math.max(1, Math.ceil(duration * source.sampleRate))
  const buffer = context.createBuffer(2, frames, source.sampleRate)
  const first = Math.round((start - source.start) * source.sampleRate)
  const lo = Math.max(0, first)
  const hi = Math.min(source.frames, first + frames)
  if (hi <= lo) return buffer
  const response = await fetch(window.cascade.mediaUrl(source.path), { headers: { Range: `bytes=${lo * 8}-${hi * 8 - 1}` } })
  if (response.status !== 206) throw new Error(`PCM range request failed: ${response.status}`)
  const pcm = new Float32Array(await response.arrayBuffer())
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1)
  const offset = lo - first
  for (let i = 0; i < pcm.length / 2; i++) {
    left[offset + i] = pcm[i * 2]
    right[offset + i] = pcm[i * 2 + 1]
  }
  return buffer
}

function drawStamp(index: number) {
  const g = stamp.getContext('2d', { alpha: false })!
  // Eight nibbles, with complementary red and a constant blue sentinel.
  const columns = Math.min(8, job.width)
  const rows = Math.ceil(8 / columns)
  for (let i = 0; i < 8; i++) {
    const value = ((index >>> (i * 4)) & 15) * 16 + 8
    g.fillStyle = `rgb(${255 - value},${value},117)`
    const column = i % columns, row = Math.floor(i / columns)
    const x = Math.floor(column * job.width / columns), y = Math.floor(row * job.stampHeight / rows)
    g.fillRect(x, y, Math.floor((column + 1) * job.width / columns) - x, Math.floor((row + 1) * job.stampHeight / rows) - y)
  }
}

async function initialize() {
  job = await bridge.job()
  app = new CascadeApp('render', window.cascade, job.project)
  const host = new PluginHost(app)
  await host.activateAll(renderPlugins.map(def => ({ def, builtin: true })))
  // User media/property plugins must participate in export just as they do in the preview.
  const files = await window.cascade.plugins.list()
  for (const file of files) {
    if (file.error) continue
    const loaded = await host.activate(await importPluginModule(file.url), false, file.url)
    if (loaded.error) throw new Error(loaded.error)
  }
  for (const plugin of host.plugins.values()) if (plugin.error) throw new Error(plugin.error)
  if (job.mode !== 'audio') {
    stage = createStage()
    stamp = document.createElement('canvas')
    stamp.width = job.width
    stamp.height = job.stampHeight
    stamp.style.cssText = `position:absolute;left:0;top:${job.height}px;width:${job.width}px;height:${job.stampHeight}px`
    document.body.appendChild(stamp)
    await document.fonts.load('16px Inter')
  }
  bridge.onCommand(command => {
    chain = chain.then(async () => {
      if (command.type === 'frame') {
        // A warm still-frame worker accepts the complete current project on every call.
        if (job.mode === 'frame') {
          const previous = job.project.id
          job = await bridge.job()
          app.doc.load(job.project)
          if (job.project.id !== previous) { disposeStage(stage!); stage = createStage() }
        }
        await stage!.renderExact(job.project, job.timelineId, command.time)
        drawStamp(command.index)
        stage!.root.getBoundingClientRect()
        bridge.frameReady(command.index)
      } else {
        const sampleRate = job.project.settings.sampleRate
        const context = new OfflineAudioContext(2, Math.max(1, Math.round(command.duration * sampleRate)), sampleRate)
        const audio: StageAudio = {
          context, destination: context.destination, chunk: { start: command.start, duration: command.duration },
          getBuffer: (media, start, duration) => audioBuffer(context, media.id, start, duration)
        }
        const audioStage = createStage(audio)
        try {
          await audioStage.renderAudioChunk(job.project, job.timelineId, Math.round(command.start * FLICKS), Math.round(command.duration * FLICKS))
          const result = await context.startRendering()
          const left = result.getChannelData(0), right = result.getChannelData(1)
          const pcm = new Float32Array(result.length * 2)
          for (let i = 0; i < result.length; i++) { pcm[i * 2] = left[i]; pcm[i * 2 + 1] = right[i] }
          bridge.audioChunk(command.index, pcm.buffer)
        } finally { disposeStage(audioStage) }
      }
    }).catch(error => bridge.error(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)))
  })
  // done doubles as the initialization handshake; commands start only after registration.
  bridge.done()
}
void initialize().catch(error => bridge.error(String(error)))
