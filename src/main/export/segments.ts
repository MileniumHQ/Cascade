import { open } from 'node:fs/promises'

const FRAME_BYTES = 8
const CHUNK = 1 << 20

/**
 * Concatenate stereo f32 PCM files onto one timeline: segment `i` begins at `startFrame` and any
 * gap before it is zero-filled (silence). Overlaps are trimmed from the later segment's head.
 * Streams in bounded chunks. Returns the total frame count written.
 */
export async function assembleSegments(output: string, segments: { path: string; startFrame: number }[]): Promise<number> {
  const out = await open(output, 'w')
  let written = 0
  const zeros = Buffer.alloc(CHUNK)
  try {
    for (const segment of segments) {
      const start = Math.max(0, Math.round(segment.startFrame))
      for (let gap = (start - written) * FRAME_BYTES; gap > 0; gap -= CHUNK) {
        await out.write(zeros, 0, Math.min(CHUNK, gap))
      }
      if (start > written) written = start
      const input = await open(segment.path, 'r')
      try {
        const buffer = Buffer.alloc(CHUNK)
        let position = Math.max(0, written - start) * FRAME_BYTES
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, CHUNK, position)
          const whole = bytesRead - (bytesRead % FRAME_BYTES)
          if (whole <= 0) break
          await out.write(buffer, 0, whole)
          position += whole
          written += whole / FRAME_BYTES
        }
      } finally { await input.close() }
    }
  } finally { await out.close() }
  return written
}
