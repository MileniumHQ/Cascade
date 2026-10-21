// Publish a GitHub release that installed copies update to (src/main/updater.ts).
// usage: bun run release [patch|minor|major|x.y.z] [--no-win] [--draft] [--dry-run]
//
// Builds the committed HEAD in a clean temporary worktree (uncommitted work never ships), with the
// version taken from the latest v* tag and bumped. package.json's version isn't edited; the builds get
// it through extraMetadata. Uploads the AppImage, Windows installer, their blockmaps and the
// latest*.yml files the updater reads, then tags HEAD. --dry-run builds into vendor/release-<tag>/dist and stops.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const bump = args.find(a => !a.startsWith('--')) ?? 'patch'

const sh = (command, argv, opts = {}) => {
  const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts })
  if (result.status !== 0) {
    if (opts.quiet) process.stderr.write(result.stderr ?? '')
    throw new Error(`${command} ${argv.join(' ')} failed (${result.status})`)
  }
  return (result.stdout ?? '').trim()
}
const out = (command, argv, opts) => sh(command, argv, { ...opts, quiet: true })

sh('gh', ['auth', 'status'], { quiet: true })
// RPM is off for now (see electron-builder.yml); add 'rpmbuild' back here and its file below to re-enable.
if (!flags.has('--no-win') && spawnSync('which', ['wine']).status !== 0) throw new Error('wine not found (needed for the Windows installer, or pass --no-win).')

// Next version from the newest v* tag.
const last = out('git', ['tag', '--list', 'v*', '--sort=-v:refname']).split('\n')[0] || 'v0.0.0'
const [major, minor, patch] = last.slice(1).split('.').map(Number)
const version = /^\d+\.\d+\.\d+$/.test(bump) ? bump
  : bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
const tag = `v${version}`
if (out('git', ['tag', '--list', tag])) throw new Error(`${tag} already exists.`)

// The tag must point at code that's on GitHub.
const head = out('git', ['rev-parse', 'HEAD'])
sh('git', ['fetch', '--quiet', 'origin', 'main'])
const dry = flags.has('--dry-run')
if (!dry && spawnSync('git', ['merge-base', '--is-ancestor', head, 'origin/main'], { cwd: root }).status !== 0) {
  throw new Error('HEAD isn’t on origin/main yet. Commit and push first (uncommitted changes are never released).')
}
const dirty = out('git', ['status', '--porcelain'])
if (dirty) console.log('Note: uncommitted changes are left out; releasing the committed HEAD only.')
console.log(`Releasing ${tag} (${head.slice(0, 7)}, after ${last})`)

// On disk under vendor/ (gitignored), not /tmp: node_modules plus three builds is several GB.
const work = join(root, 'vendor', `release-${tag}`)
mkdirSync(join(root, 'vendor'), { recursive: true })
rmSync(work, { recursive: true, force: true })
spawnSync('git', ['worktree', 'prune'], { cwd: root })
try {
  sh('git', ['worktree', 'add', '--detach', work, head])
  // Built binaries aren't in git; reuse this checkout's.
  cpSync(join(root, 'resources/whisper'), join(work, 'resources/whisper'), { recursive: true })
  const inWork = { cwd: work }
  sh('bun', ['install', '--frozen-lockfile'], inWork)
  const meta = `-c.extraMetadata.version=${version}`
  sh('bunx', ['electron-vite', 'build'], inWork)
  sh('bunx', ['electron-builder', '--linux', '--x64', '--publish', 'never', meta], inWork)
  if (!flags.has('--no-win')) sh('node', ['scripts/dist-win.mjs', '--publish', 'never', meta], inWork)

  const dist = join(work, 'dist')
  const files = ['Cascade-linux-x86_64.AppImage', /* 'Cascade-linux-x86_64.rpm', */ 'latest-linux.yml']
  if (!flags.has('--no-win')) files.push('Cascade-windows-x64-setup.exe', 'Cascade-windows-x64-setup.exe.blockmap', 'latest.yml')
  for (const f of files) if (!existsSync(join(dist, f))) throw new Error(`Missing build output ${f}`)
  const appImage = join(dist, 'Cascade-linux-x86_64.AppImage')
  writeFileSync(`${appImage}.sha256`, `${createHash('sha256').update(readFileSync(appImage)).digest('hex')}  Cascade-linux-x86_64.AppImage\n`)
  files.push('Cascade-linux-x86_64.AppImage.sha256')

  if (dry) {
    const keep = join(root, 'vendor', `release-${tag}-dist`)
    rmSync(keep, { recursive: true, force: true })
    cpSync(dist, keep, { recursive: true, filter: src => !src.includes('-unpacked') })
    console.log(`\nDry run: built ${files.join(', ')} in ${keep}. Nothing tagged or published.`)
  } else {
    sh('git', ['tag', tag, head])
    sh('git', ['push', 'origin', tag])
    sh('gh', ['release', 'create', tag, '--title', `Cascade ${version}`, '--generate-notes', '--verify-tag',
      ...(flags.has('--draft') ? ['--draft'] : ['--latest']), ...files.map(f => join(dist, f))])
    console.log(`\nPublished ${tag}. Installed copies pick it up within 4 hours (or Help → Check for Updates).`)
  }
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', work], { cwd: root, stdio: 'inherit' })
  rmSync(work, { recursive: true, force: true })
}
