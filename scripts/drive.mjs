// Launch the built app with Playwright, run an optional step script, save screenshots.
// usage: node scripts/drive.mjs <outdir> [steps.mjs]
// CASCADE_EXE=dist/linux-unpacked/cascade drives a packaged build instead of the dev build in out/.
// CASCADE_ARGS (one per line) are appended to the app's argv, e.g. a .cascade file to open.
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve(process.argv[2] ?? '/tmp/cascade-shots')
mkdirSync(out, { recursive: true })
const env = { ...process.env, CASCADE_USER_DATA: process.env.CASCADE_USER_DATA ?? '/tmp/cascade-test-profile' }
delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.CASCADE_EXE
const extra = process.env.CASCADE_ARGS?.split('\n').filter(Boolean) ?? []
const app = await electron.launch(packaged
  ? { executablePath: resolve(packaged), args: ['--no-sandbox', ...extra], env }
  : { executablePath: resolve('node_modules/electron/dist/electron'), args: ['.', '--no-sandbox', ...extra], env })
const logs = []
app.on('window', (w) => {
  w.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  w.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e}`))
})
let win
for (let i = 0; i < 100; i++) {
  win = app.windows().find((w) => w.url().includes('index.html'))
  if (win) break
  await new Promise((r) => setTimeout(r, 100))
}
if (!win) throw new Error('main window not found: ' + app.windows().map((w) => w.url()))
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e}`))
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))
const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
try {
  if (process.argv[3]) {
    const steps = await import(resolve(process.argv[3]))
    await steps.default({ app, win, shot, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  } else await shot('home')
} catch (e) {
  logs.push('[driver] ' + (e.stack ?? e))
  await shot('error').catch(() => {})
} finally {
  console.log(logs.filter((l) => !l.includes('Electron Security Warning')).join('\n'))
  await app.close()
}
