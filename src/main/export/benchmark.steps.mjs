import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const output = process.env.CASCADE_BENCH_OUT ?? '/tmp/cascade-export-bench'
export default async ({ win, shot }) => {
  await mkdir(output, { recursive: true })
  await win.click('text=New project')
  await win.click('.modal .btn-primary')
  await win.waitForFunction(() => !!window.cascadeApp?.edit)
  const setup = await win.evaluate(async () => {
    const app = window.cascadeApp
    app.edit.setProjectSettings({ fps: { num: 30000, den: 1001 } })
    const ids = await app.edit.importFiles([`${(await app.host.info()).paths.home}/wwdc.webm`])
    const clips = app.edit.addMediaToTimeline(ids[0], { start: 0 })
    const text = app.edit.addGenerated('text')
    const overlay = app.edit.addMediaToTimeline(text, { start: 0, trackId: app.timeline().tracks.filter(t => t.kind === 'visual')[1].id })[0]
    const textClip = app.timeline().tracks.flatMap(t => t.clips).find(c => c.id === overlay)
    app.edit.setParam(overlay, textClip.properties.find(p => p.type === 'text').id, 'text', 'Cascade export benchmark')
    app.doc.transact('Extend animated overlay', d => {
      for (const track of d.timelines[d.activeTimeline].tracks) {
        const clip = track.clips.find(c => c.id === overlay)
        if (clip) clip.duration = app.edit.seconds(600)
      }
    })
    const clip = app.timeline().tracks.flatMap(t => t.clips).find(c => c.id === overlay)
    const transform = clip.properties.find(p => p.type === 'transform')
    app.edit.addKeyframe(overlay, transform.id, 'position', 0, [-0.25, 0.3], { id: 'linear' })
    app.edit.addKeyframe(overlay, transform.id, 'position', app.edit.seconds(60), [0.25, 0.3], { id: 'linear' })
    window.benchProgress = []
    app.host.export.onProgress(p => { window.benchProgress.push(p); window.benchLast = p })
    return { info: await app.host.info(), clips, overlay }
  })
  await writeFile(`${output}/setup.json`, JSON.stringify(setup, null, 2))
  console.log('BENCH_SETUP', JSON.stringify(setup.info.ffmpeg))
  const cases = JSON.parse(process.env.CASCADE_BENCH_CASES ?? '[{"name":"smoke","seconds":2,"width":640,"height":360,"workers":1,"hardware":false}]')
  const results = []
  for (const test of cases) {
    const start = Date.now()
    const id = await win.evaluate(async ({ test, output }) => {
      const app = window.cascadeApp
      const exporter = app.registries.exporters.get(test.exporter ?? 'mp4-h264')
      const options = Object.fromEntries(exporter.options.map(o => [o.id, o.default]))
      Object.assign(options, { hardware: test.hardware, ...test.options })
      const encoding = exporter.ffmpeg(options, { width: test.width, height: test.height, fps: app.fps(), hasAudio: test.audio !== false, hwEncoders: (await app.host.info()).ffmpeg.hwEncoders })
      window.benchLast = null
      return app.host.export.start({ project: app.project(), timelineId: app.project().activeTimeline, width: test.width, height: test.height, fps: app.fps(), range: { start: app.edit.seconds(test.start ?? 0), end: app.edit.seconds((test.start ?? 0) + test.seconds) }, exporter: exporter.id, options, workers: test.workers, encoding, output: `${output}/${test.name}.${exporter.extension}` })
    }, { test, output })
    for (;;) {
      await new Promise(r => setTimeout(r, 1000))
      const progress = await win.evaluate(id => window.benchProgress.filter(p => p.jobId === id).at(-1), id)
      if (!progress) continue
      if (['done', 'error', 'cancelled'].includes(progress.state)) {
        const seconds = progress.state === 'done' ? progress.framesTotal / progress.fps : (Date.now() - start) / 1000
        let probe
        if (progress.state === 'done' && test.exporter !== 'png-sequence') {
          probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=index,codec_name,width,height,r_frame_rate,nb_read_frames,duration,start_time:format=duration', '-of', 'json', progress.output], { encoding: 'utf8' }))
        }
        const result = { ...test, elapsed: seconds, fps: progress.framesTotal / seconds, realtime: test.seconds / seconds, progress, probe }
        results.push(result)
        await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
        console.log('BENCH_RESULT', JSON.stringify(result))
        if (progress.state !== 'done') throw new Error(progress.message)
        break
      }
      console.log('BENCH_PROGRESS', test.name, progress.framesDone, '/', progress.framesTotal, progress.fps.toFixed(1), progress.message ?? '')
    }
  }
  await shot('export-project')
  const stills = await win.evaluate(async () => {
    const app = window.cascadeApp
    const result = []
    for (const time of [0, 15, 30]) {
      const start = performance.now()
      const png = await app.host.export.frame({ project: app.project(), timelineId: app.project().activeTimeline, time: app.edit.seconds(time), width: 1920, height: 1080 })
      result.push({ time, ms: performance.now() - start, png })
    }
    return result
  })
  for (const still of stills) await writeFile(`${output}/still-${still.time}.png`, Buffer.from(still.png.split(',')[1], 'base64'))
  await writeFile(`${output}/stills.json`, JSON.stringify(stills.map(({ png, ...info }) => info), null, 2))
}
