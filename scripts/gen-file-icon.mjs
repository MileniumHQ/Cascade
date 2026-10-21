// Renders the .cascade document icon (resources/file-icon.svg) for the packager:
// file-icon.png (Linux mime icon, 512px) and file-icon.ico (Windows, PNG-compressed sizes).
// Needs rsvg-convert (librsvg). Run `node scripts/gen-file-icon.mjs`, commit the outputs.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const res = (name) => fileURLToPath(new URL(`../resources/${name}`, import.meta.url))
const render = (size) => execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), res('file-icon.svg')], { maxBuffer: 64 << 20 })

writeFileSync(res('file-icon.png'), render(512))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(render)
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i
  header.writeUInt8(size % 256, entry) // 0 means 256
  header.writeUInt8(size % 256, entry + 1)
  header.writeUInt16LE(1, entry + 4) // planes
  header.writeUInt16LE(32, entry + 6) // bits per pixel
  header.writeUInt32LE(images[i].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += images[i].length
})
writeFileSync(res('file-icon.ico'), Buffer.concat([header, ...images]))
console.log(`file-icon.png, file-icon.ico (${sizes.join(', ')})`)
