/** Adobe/IRIDAS .cube 3D LUT. Entries are RGB with red varying fastest. */
export interface CubeLUT {
  size: number
  domainMin: number[]
  domainMax: number[]
  data: Float32Array
}

export function parseCube(text: string): CubeLUT {
  let size = 0
  let domainMin = [0, 0, 0]
  let domainMax = [1, 1, 1]
  const entries: number[] = []
  const seen = new Set<string>()
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.split('#')[0].trim()
    if (!line) continue
    const [token, ...args] = line.split(/\s+/)
    const fail = (message: string): never => { throw new Error(`.cube line ${index + 1}: ${message}`) }
    if (token === 'TITLE') continue
    if (['LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'].includes(token)) {
      if (seen.has(token)) fail(`duplicate ${token}`)
      seen.add(token)
      const numbers = args.map(Number)
      if (numbers.some(v => !Number.isFinite(v))) fail('non-finite value')
      if (token === 'LUT_3D_SIZE') {
        if (args.length !== 1 || !Number.isInteger(numbers[0]) || numbers[0] < 2 || numbers[0] > 65) fail('LUT_3D_SIZE must be an integer from 2 to 65')
        size = numbers[0]
      } else {
        if (args.length !== 3) fail(`${token} requires three values`)
        if (token === 'DOMAIN_MIN') domainMin = numbers
        else domainMax = numbers
      }
      continue
    }
    if (!size) fail('expected LUT_3D_SIZE before data (only 3D LUTs are supported)')
    const row = [token, ...args].map(Number)
    if (row.length !== 3 || row.some(v => !Number.isFinite(v))) fail('expected three finite RGB values')
    entries.push(...row)
    if (entries.length > size ** 3 * 3) fail('too many entries')
  }
  if (!size || entries.length !== size ** 3 * 3) throw new Error(`.cube requires ${size ? size ** 3 : 'LUT_3D_SIZE and'} RGB entries; got ${entries.length / 3}`)
  if (domainMax.some((v, i) => v <= domainMin[i])) throw new Error('.cube DOMAIN_MAX must exceed DOMAIN_MIN on every channel')
  return { size, domainMin, domainMax, data: new Float32Array(entries) }
}

/** Pack domain metadata with the texture, so no mutable plugin state is needed during loading. */
export function cubeTexture(text: string, key: string) {
  const lut = parseCube(text)
  // Two extra RGB texels in a separate 2D row would need another sampler. Instead the
  // 3D texture adds two x slices: domain min/max are stored outside the LUT lattice.
  const width = lut.size + 2
  const data = new Float32Array(width * lut.size * lut.size * 3)
  for (let z = 0; z < lut.size; z++) for (let y = 0; y < lut.size; y++) {
    const row = (z * lut.size + y) * width * 3
    data.set(lut.domainMin, row)
    data.set(lut.domainMax, row + 3)
    const start = (z * lut.size + y) * lut.size * 3
    data.set(lut.data.subarray(start, start + lut.size * 3), row + 6)
  }
  return { key, width, height: lut.size, depth: lut.size, data }
}
