export default async ({ win, shot, sleep }) => {
  await win.click('text=New project')
  await sleep(300)
  await shot('newproject')
  await win.click('.modal .btn-primary')
  await sleep(1500)
  await win.evaluate(async () => {
    const app = window.cascadeApp
    const ids = await app.edit.importFiles([`${(await app.host.info()).paths.home}/wwdc.webm`])
    app.edit.addMediaToTimeline(ids[0], { start: 0 })
    const g = app.edit.addGenerated('text')
    app.edit.addMediaToTimeline(g, { start: app.edit.seconds(2) })
    app.playback.seek(app.edit.seconds(600))
  })
  await sleep(4000)
  await shot('editor')
}
