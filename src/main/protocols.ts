import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'

const mimeTypes: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  aac: 'audio/aac', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  json: 'application/json', bin: 'application/octet-stream', f32: 'application/octet-stream'
}

export const mediaUrl = (path: string): string => `media://local/${encodeURIComponent(path)}`

/** null means no Range; false means malformed or unsatisfiable (including multipart ranges). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | false {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export async function serveMedia(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (url.hostname !== 'local') return new Response('Unknown media host', { status: 404 })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    const path = decodeURIComponent(url.pathname.slice(1))
    if (!isAbsolute(path) || path.includes('\0')) return new Response('Invalid path', { status: 400 })
    const file = await stat(path)
    if (!file.isFile()) return new Response('Not a file', { status: 404 })
    const range = parseRange(request.headers.get('Range'), file.size)
    const headers = new Headers({
      'Content-Type': mimeTypes[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*'
    })
    if (range === false) {
      headers.set('Content-Range', `bytes */${file.size}`)
      return new Response(null, { status: 416, headers })
    }
    const start = range?.start ?? 0
    const end = range?.end ?? file.size - 1
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
    if (request.method === 'HEAD' || file.size === 0) return new Response(null, { status: range ? 206 : 200, headers })
    const stream = createReadStream(path, { start, end })
    const abort = (): void => { stream.destroy() }
    request.signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => request.signal.removeEventListener('abort', abort))
    if (request.signal.aborted) abort()
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(code === 'ENOENT' ? 'File not found' : 'Unable to read media', { status: code === 'ENOENT' ? 404 : 400 })
  }
}

export function servePlugin(request: Request, lookup: (name: string) => string | undefined): Response {
  try {
    const url = new URL(request.url)
    if (url.hostname !== 'plugins' || !url.pathname.endsWith('.js')) return new Response(null, { status: 404 })
    const code = lookup(decodeURIComponent(url.pathname.slice(1, -3)))
    if (code === undefined) return new Response('Plugin not found or failed to build', { status: 404 })
    return new Response(code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } })
  } catch { return new Response(null, { status: 400 }) }
}
