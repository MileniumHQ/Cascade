// Windows x64 installer, built from Linux: cross-compiled whisper, Windows prebuilts, then electron-builder (wine for rcedit/NSIS).
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!['whisper-cli.exe', 'cascade-align.exe'].every((exe) => existsSync(`${root}resources/whisper/win32-x64/${exe}`))) run('node', ['scripts/setup-whisper.mjs', '--target', 'win32-x64'])
run('node', ['scripts/fetch-win-deps.mjs'])
run('bunx', ['electron-vite', 'build'])
run('bunx', ['electron-builder', '--win', '--x64', ...process.argv.slice(2)])
