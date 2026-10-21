import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { desktopEntry, registerLinuxDesktop } from './desktop-integration'

const xdg = process.env.XDG_DATA_HOME
afterEach(() => { if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg })

test('desktop entry quotes the AppImage path per the spec', () => {
  expect(desktopEntry('/home/a b/Cascade "x" $1.AppImage')).toContain('Exec="/home/a b/Cascade \\\\"x\\\\" \\\\$1.AppImage" %U')
})

test('installs the mime type with its own icon, plus a desktop entry for the AppImage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cascade-desktop-'))
  const resources = join(root, 'resources')
  await mkdir(join(resources, 'icons'), { recursive: true })
  await writeFile(join(resources, 'icons', 'file-icon.png'), 'doc')
  await writeFile(join(resources, 'icons', 'icon.png'), 'app')
  process.env.XDG_DATA_HOME = join(root, 'data')
  await registerLinuxDesktop(resources, '/opt/Cascade.AppImage')
  const data = join(root, 'data')
  expect(await readFile(join(data, 'mime/packages/cascade.xml'), 'utf8')).toContain('<icon name="application-x-cascade-project"/>')
  expect(await readFile(join(data, 'icons/hicolor/512x512/mimetypes/application-x-cascade-project.png'), 'utf8')).toBe('doc')
  expect(await readFile(join(data, 'icons/hicolor/512x512/apps/cascade.png'), 'utf8')).toBe('app')
  expect(await readFile(join(data, 'applications/cascade.desktop'), 'utf8')).toContain('MimeType=application/x-cascade-project;')
})
