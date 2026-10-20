import benchmark from './benchmark.steps.mjs'
import { execFileSync } from 'node:child_process'
import { readdir, writeFile, stat } from 'node:fs/promises'

export default async context => {
  const { app, win } = context
  await benchmark(context)
  const output = process.env.CASCADE_BENCH_OUT ?? '/tmp/cascade-export-formats'
  const tests = {}
  tests.cancel = await win.evaluate(async output => {
    const app = window.cascadeApp
    const exp = app.registries.exporters.get('mp4-h264')
    const options = { hardware: false }
    const request = { project: app.project(), timelineId: app.project().activeTimeline, width: 1920, height: 1080, fps: app.fps(), range: { start: 0, end: app.edit.seconds(600) }, output: `${output}/cancel.mp4`, exporter: exp.id, options, workers: 6, encoding: exp.ffmpeg(options, { width: 1920, height: 1080, fps: app.fps(), hasAudio: true, hwEncoders: [] }) }
    const id = await app.host.export.start(request)
    await new Promise(r => setTimeout(r, 500))
    const start = performance.now()
    await app.host.export.cancel(id)
    return { id, ms: performance.now() - start, terminal: window.benchProgress.filter(p => p.jobId === id).at(-1) }
  }, output)
  tests.immediateCancel = await win.evaluate(async output => {
    const app = window.cascadeApp
    const exp = app.registries.exporters.get('mp4-h264')
    const id = await app.host.export.start({ project: app.project(), timelineId: app.project().activeTimeline, width: 1920, height: 1080, fps: app.fps(), range: { start: 0, end: app.edit.seconds(60) }, output: `${output}/cancel-immediate.mp4`, exporter: exp.id, options: {}, encoding: exp.ffmpeg({}, { width: 1920, height: 1080, fps: app.fps(), hasAudio: true, hwEncoders: [] }) })
    await app.host.export.cancel(id)
    return window.benchProgress.filter(p => p.jobId === id).at(-1)
  }, output)
  tests.fallback = await win.evaluate(async output => {
    const app = window.cascadeApp
    const exp = app.registries.exporters.get('mp4-h264')
    const encoding = exp.ffmpeg({}, { width: 320, height: 180, fps: app.fps(), hasAudio: true, hwEncoders: ['h264_vaapi'] })
    encoding.inputArgs = ['-vaapi_device', '/dev/dri/cascade-does-not-exist']
    const id = await app.host.export.start({ project: app.project(), timelineId: app.project().activeTimeline, width: 320, height: 180, fps: app.fps(), range: { start: app.edit.seconds(10), end: app.edit.seconds(11) }, output: `${output}/fallback.mp4`, exporter: exp.id, options: {}, workers: 3, encoding })
    for (;;) {
      await new Promise(r => setTimeout(r, 50))
      const progress = window.benchProgress.filter(p => p.jobId === id)
      const terminal = progress.at(-1)
      if (terminal && ['done','error','cancelled'].includes(terminal.state)) return { terminal, fallback: progress.find(p => p.message?.includes('retrying in software'))?.message }
    }
  }, output)
  tests.changedProject = await win.evaluate(async () => {
    const app = window.cascadeApp
    const time = app.edit.seconds(15)
    const frame = () => app.host.export.frame({ project: app.project(), timelineId: app.project().activeTimeline, time, width: 640, height: 360 })
    const a = await frame()
    const overlay = app.timeline().tracks.flatMap(t=>t.clips).find(c=>c.type === 'element')
    const text = overlay.properties.find(p=>p.type === 'text')
    app.edit.setParam(overlay.id, text.id, 'text', 'UPDATED WARM WORKER')
    const b = await frame()
    const tiny = await app.host.export.frame({ project: app.project(), timelineId: app.project().activeTimeline, time: 0, width: 1, height: 1 })
    return { changed: a !== b, tinyPNG: tiny.startsWith('data:image/png;base64,') }
  })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', `${output}/tone.wav`])
  tests.audioMix = await win.evaluate(async output => {
    const app = window.cascadeApp
    app.edit.deleteClips(app.timeline().tracks.flatMap(t => t.clips.map(c => c.id)))
    const [mediaId] = await app.edit.importFiles([`${output}/tone.wav`])
    const seconds = t => app.edit.seconds(t)
    const first = app.edit.insertClip({ type: 'audio', mediaId, start: seconds(3), duration: seconds(2) })
    const property = app.timeline().tracks.flatMap(t=>t.clips).find(c=>c.id === first).properties.find(p=>p.type === 'volume')
    for (const [time, value] of [[0,-6],[1,-6],[1.01,-18]]) app.edit.addKeyframe(first, property.id, 'gain', seconds(time), value, { id: 'linear' })
    app.edit.insertClip({ type: 'audio', mediaId, start: seconds(9.5), duration: seconds(2) })
    app.edit.insertClip({ type: 'audio', mediaId, start: seconds(15), duration: seconds(1), speed: 2 })
    const muted = app.edit.addTrack('audio')
    app.edit.insertClip({ type: 'audio', mediaId, start: seconds(17), duration: seconds(2) }, muted)
    app.edit.updateTrack(muted, { muted: true })
    const exp = app.registries.exporters.get('wav')
    const id = await app.host.export.start({ project: app.project(), timelineId: app.project().activeTimeline, width: 8, height: 8, fps: app.fps(), range: { start: 0, end: seconds(20) }, output: `${output}/mix.wav`, exporter: exp.id, options: {}, encoding: exp.ffmpeg({}, { width: 8, height: 8, fps: app.fps(), hasAudio: true, hwEncoders: [] }) })
    for (;;) {
      await new Promise(r=>setTimeout(r, 50))
      const terminal = window.benchProgress.filter(p=>p.jobId === id).at(-1)
      if (terminal && ['done','error','cancelled'].includes(terminal.state)) return terminal
    }
  }, output)
  tests.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w=>({ url:w.webContents.getURL(), id:w.id })))
  tests.tempDirectories = (await readdir(output)).filter(name=>name.startsWith('.cascade-export-'))
  tests.cancelOutputExists = await stat(`${output}/cancel.mp4`).then(()=>true,()=>false)
  await writeFile(`${output}/verification.json`, JSON.stringify(tests, null, 2))
  console.log('VERIFY_RESULT', JSON.stringify(tests))
  if (tests.cancel.terminal.state !== 'cancelled' || tests.immediateCancel.state !== 'cancelled' || tests.fallback.terminal.state !== 'done' || !tests.fallback.fallback || !tests.changedProject.changed || !tests.changedProject.tinyPNG || tests.tempDirectories.length || tests.cancelOutputExists || tests.audioMix.state !== 'done') throw new Error('Export verification failed')
}
