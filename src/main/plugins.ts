import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { build, stop, type BuildFailure } from 'esbuild'
import type { PluginFile } from '../shared/ipc'

interface BuiltPlugin { file: PluginFile; version: number; code?: string; fingerprint: string }
const extensions = ['.ts', '.tsx', '.js', '.mjs']

export class UserPlugins {
  private plugins = new Map<string, BuiltPlugin>()
  private versions = new Map<string, number>()
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(readonly directory: string, private readonly changed: (files: PluginFile[]) => void) {}

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.refresh(true)
    await this.installWatchers()
  }

  list(): PluginFile[] { return [...this.plugins.values()].map((p) => ({ ...p.file })).sort((a, b) => a.name.localeCompare(b.name)) }
  code(name: string): string | undefined { return this.plugins.get(name)?.code }

  private name(value: string): string {
    if (!value || value === '.' || value === '..' || value !== basename(value) || !/^[\p{L}\p{N}_. -]+$/u.test(value)) throw new Error('Invalid plugin name')
    return value
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.pending.then(work)
    this.pending = pending.catch((error: unknown) => console.warn('Plugin refresh failed:', error))
    return pending
  }

  private schedule = (): void => {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.enqueue(async () => {
        await this.refresh(false)
        await this.installWatchers()
      }).catch(() => {})
    }, 150)
  }

  private async entries(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const entries = (await readdir(this.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    // A written .ts entry takes precedence over old JavaScript or a same-named folder.
    for (const ext of extensions) for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isFile() && extname(entry.name) === ext) {
        const name = basename(entry.name, extname(entry.name))
        if (!result.has(name)) result.set(name, join(this.directory, entry.name))
      }
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.') && entry.isDirectory() && !result.has(entry.name)) {
        for (const ext of extensions) {
          const path = join(this.directory, entry.name, `index${ext}`)
          try { if ((await stat(path)).isFile()) { result.set(entry.name, path); break } } catch { /* Try next extension. */ }
        }
      }
    }
    return result
  }

  private async compile(name: string, path: string): Promise<BuiltPlugin> {
    const version = (this.versions.get(name) ?? 0) + 1
    const file: PluginFile = { name, path, url: `cascade-plugin://plugins/${encodeURIComponent(name)}.js?v=${version}` }
    try {
      const result = await build({ entryPoints: [path], bundle: true, format: 'esm', platform: 'browser', target: 'esnext', write: false, metafile: true, logLevel: 'silent', sourcemap: 'inline', sourcesContent: true })
      const code = result.outputFiles[0].text
      return { file, version, code, fingerprint: `${path}\0${code}` }
    } catch (error) {
      const errors = (error as BuildFailure).errors
      file.error = errors?.map((e) => `${e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ` : ''}${e.text}`).join('\n') || String(error)
      return { file, version, fingerprint: `${path}\0${file.error}` }
    }
  }

  private async refresh(force: boolean): Promise<void> {
    if (this.disposed) return
    const entries = await this.entries()
    let modified = false
    for (const name of this.plugins.keys()) {
      if (!entries.has(name)) { this.plugins.delete(name); modified = true }
    }
    for (const [name, path] of entries) {
      const next = await this.compile(name, path)
      if (force || next.fingerprint !== this.plugins.get(name)?.fingerprint) {
        this.plugins.set(name, next)
        this.versions.set(name, next.version)
        modified = true
      }
    }
    if (modified && !this.disposed) this.changed(this.list())
  }

  private async installWatchers(): Promise<void> {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    // Watch each directory rather than relying on recursive fs.watch support on a particular OS.
    const visited = new Set<string>()
    const visit = async (directory: string): Promise<void> => {
      if (this.disposed || visited.has(directory)) return
      visited.add(directory)
      try {
        const watcher = watch(directory, this.schedule)
        watcher.on('error', (error) => console.warn('Plugin watch failed:', error.message))
        this.watchers.push(watcher)
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await visit(join(directory, entry.name))
        }
      } catch (error) { console.warn('Unable to watch plugin directory:', error) }
    }
    await visit(this.directory)
  }

  async write(name: string, code: string): Promise<PluginFile> {
    name = this.name(name)
    await this.enqueue(async () => {
      await writeFile(join(this.directory, `${name}.ts`), code, 'utf8')
      await this.refresh(true)
      await this.installWatchers()
    })
    return this.plugins.get(name)!.file
  }

  async remove(name: string): Promise<void> {
    name = this.name(name)
    await this.enqueue(async () => {
      // Remove all matching entries, so an older .js doesn't reappear after removing a .ts.
      for (const ext of extensions) await rm(join(this.directory, `${name}${ext}`), { force: true })
      await rm(join(this.directory, name), { recursive: true, force: true })
      await this.refresh(false)
      await this.installWatchers()
    })
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    stop()
  }
}
