// Adds the Windows x64 prebuilt binaries that a Linux install skips (platform-specific optional dependencies),
// so `bun run dist:win` can package from Linux. They sit next to the Linux ones (different package names / file
// names), so the dev setup is unaffected. Idempotent; rerun after `bun install`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const modules = join(root, 'node_modules')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Parent package → its Windows x64 optional dependency. */
const PARENTS = ['sherpa-onnx-node', 'esbuild', '@anthropic-ai/claude-agent-sdk', '@openai/codex']

async function npmPackage(parent) {
  const pkg = json(join(modules, parent, 'package.json'))
  const entry = Object.entries(pkg.optionalDependencies ?? {}).find(([name]) => /(^|[-/])win(32)?-x64$/.test(name))
  if (!entry) throw new Error(`${parent} has no win32-x64 optional dependency`)
  const [name, spec] = entry
  // "npm:@openai/codex@0.160.1-win32-x64" (alias) or "^1.13.8" (pinned to the parent's version when it matches).
  const alias = spec.match(/^npm:(.+)@([^@]+)$/)
  const source = alias ? alias[1] : name
  const version = alias ? alias[2] : spec.replace(/^[\^~]/, '') === pkg.version.replace(/^[\^~]/, '') ? pkg.version : spec.replace(/^[\^~]/, '')
  const dir = join(modules, name)
  if (existsSync(join(dir, 'package.json')) && json(join(dir, 'package.json')).version === version) return console.log(`${name}@${version} present`)
  const meta = await (await fetch(`https://registry.npmjs.org/${source.replace('/', '%2f')}/${version}`)).json()
  if (!meta.dist?.tarball) throw new Error(`No tarball for ${source}@${version}`)
  console.log(`${name}@${version} ← ${meta.dist.tarball}`)
  const tgz = join(modules, `.${name.replace('/', '_')}.tgz`)
  await pipeline(Readable.fromWeb((await fetch(meta.dist.tarball)).body), createWriteStream(tgz))
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' })
  rmSync(tgz)
  if (tar.status !== 0) throw new Error(`Extracting ${name} failed`)
}

/** ffmpeg-static downloads only the host binary at install; fetch ffmpeg.exe from the same release. */
async function ffmpeg() {
  const dir = join(modules, 'ffmpeg-static')
  const pkg = json(join(dir, 'package.json'))
  const tag = pkg['ffmpeg-static']['binary-release-tag']
  const exe = join(dir, 'ffmpeg.exe'), stamp = join(dir, 'ffmpeg.exe.tag')
  if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8') === tag) return console.log(`ffmpeg.exe ${tag} present`)
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-win32-x64.gz`
  console.log(`ffmpeg.exe ← ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`ffmpeg download failed (${response.status})`)
  await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(exe))
  writeFileSync(stamp, tag)
}

for (const parent of PARENTS) await npmPackage(parent)
await ffmpeg()
