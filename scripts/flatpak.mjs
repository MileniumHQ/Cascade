// Build and install the Flatpak locally from dist/Cascade-linux-x64.tar.gz (`bun run dist:linux` first), using
// the Flathub manifest in flatpak/ with its release archive swapped for the local one. Needs flatpak and the
// org.flatpak.Builder app (installed per user here if missing). `--lint` also runs Flathub's linter; `--bundle`
// also writes the single-file dist/Cascade-linux-x86_64.flatpak (runtimes resolve from Flathub on install).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ID = 'com.mileniumhq.Cascade'
const root = fileURLToPath(new URL('../', import.meta.url))
const archive = join(root, 'dist/Cascade-linux-x64.tar.gz')
if (!existsSync(archive)) throw new Error('dist/Cascade-linux-x64.tar.gz missing; run `bun run dist:linux` first.')
const bundle = process.argv.includes('--bundle')
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}
// From the host: flatpak-builder's own --install-deps-from can't see the flathub remote inside its sandbox.
const need = ['org.flatpak.Builder', 'org.freedesktop.Platform//26.08', 'org.freedesktop.Sdk//26.08', 'org.electronjs.Electron2.BaseApp//26.08']
const missing = need.filter(ref => spawnSync('flatpak', ['info', ref], { stdio: 'ignore' }).status !== 0)
if (missing.length) run('flatpak', ['install', '--user', '--noninteractive', 'flathub', ...missing])

// The manifest's sources are relative to it, so the local copy sits beside copies of them.
const work = join(root, 'vendor/flatpak')
mkdirSync(work, { recursive: true })
for (const f of readdirSync(join(root, 'flatpak'))) if (!f.endsWith('.yml') && f !== 'screenshots') copyFileSync(join(root, 'flatpak', f), join(work, f))
const manifest = readFileSync(join(root, 'flatpak', `${ID}.yml`), 'utf8')
const local = manifest.replace(/( {6}- type: archive\n)[\s\S]*?(?=\n {6}- type: file)/, `$1        dest: cascade\n        path: ${archive}`)
if (local === manifest) throw new Error('Could not swap the archive source in the manifest')
writeFileSync(join(work, `${ID}.yml`), local)

// The sandboxed builder asks the host's flatpak for the SDK with its own XDG_DATA_HOME, which hides --user installs.
const builder = (...args) => run('flatpak', ['run', `--env=FLATPAK_USER_DIR=${join(homedir(), '.local/share/flatpak')}`, '--command=flatpak-builder', 'org.flatpak.Builder', ...args])
builder('--user', '--install', '--force-clean', '--ccache', `--state-dir=${join(work, '.state')}`,
  ...(process.argv.includes('--lint') || bundle ? [`--repo=${join(work, 'repo')}`] : []), join(work, 'build'), join(work, `${ID}.yml`))
if (bundle) {
  run('flatpak', ['build-bundle', '--runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo', join(work, 'repo'), join(root, 'dist/Cascade-linux-x86_64.flatpak'), ID])
  console.log('Wrote dist/Cascade-linux-x86_64.flatpak')
}
// Reported, not fatal: --filesystem=home needs an exception that Flathub grants on review.
if (process.argv.includes('--lint')) for (const what of [['manifest', join(root, 'flatpak', `${ID}.yml`)], ['repo', join(work, 'repo')]]) {
  spawnSync('flatpak', ['run', '--command=flatpak-builder-lint', 'org.flatpak.Builder', ...what], { stdio: 'inherit' })
}
console.log(`Installed ${ID}. Run it with: flatpak run ${ID}`)
