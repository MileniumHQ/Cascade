import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, rm, open, rename } from 'node:fs/promises'

export async function size(path: string) { return (await stat(path).catch(() => null))?.size ?? 0 }
export async function sha256(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export interface ModelDownload { id: string; name: string; sizeBytes: number; sha256: string; url: string }

/** Streaming, resumable, checksum-verified download. The caller creates the parent directory. */
export async function downloadModel(model: ModelDownload, target: string, signal: AbortSignal, progress: (value: number, message: string) => void) {
    if (await size(target) === model.sizeBytes && await sha256(target) === model.sha256) return
    const partial = `${target}.partial`
    let offset = await size(partial)
    if (offset > model.sizeBytes) { await rm(partial); offset = 0 }
    if (offset < model.sizeBytes) {
      const response = await fetch(model.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal })
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`)
      if (response.status === 206) {
        if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Invalid model download resume offset')
      } else offset = 0 // Server ignored Range: replace the partial file.
      const file = await open(partial, offset ? 'a' : 'w')
      let last = 0
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          await file.writeFile(chunk)
          offset += chunk.length
          if (Date.now() - last > 250) {
            last = Date.now()
            progress(Math.min(1, offset / model.sizeBytes), `Downloading ${model.name}`)
          }
        }
      } finally { await file.close() }
    }
    signal.throwIfAborted()
    progress(1, `Verifying ${model.name}`)
    if (await size(partial) !== model.sizeBytes || await sha256(partial) !== model.sha256) {
      await rm(partial, { force: true })
      throw new Error(`Model checksum mismatch: ${model.id}. Retry the download.`)
    }
    signal.throwIfAborted()
    await rename(partial, target)
}
