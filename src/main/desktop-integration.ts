import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MIME = 'application/x-cascade-project'
const MIME_ICON = MIME.replace('/', '-')

/**
 * Linux: give .cascade files their document icon (and, for the AppImage, an "Open with Cascade" desktop entry).
 * electron-builder's mime XML names a generic icon, and the AppImage installs nothing, so this writes per-user
 * files under $XDG_DATA_HOME; they take precedence over the system ones. Rewritten only when they change.
 */
export async function registerLinuxDesktop(resourcesPath: string, appImage = process.env.APPIMAGE): Promise<void> {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const icons = join(resourcesPath, 'icons')
  const files: [string, string | { copy: string }][] = [
    [join(data, 'mime', 'packages', 'cascade.xml'), mimeXml()],
    [join(data, 'icons', 'hicolor', '512x512', 'mimetypes', `${MIME_ICON}.png`), { copy: join(icons, 'file-icon.png') }]
  ]
  if (appImage) files.push(
    [join(data, 'applications', 'cascade.desktop'), desktopEntry(appImage)],
    [join(data, 'icons', 'hicolor', '512x512', 'apps', 'cascade.png'), { copy: join(icons, 'icon.png') }]
  )
  let changed = false
  for (const [target, content] of files) {
    const bytes = typeof content === 'string' ? Buffer.from(content) : await readFile(content.copy)
    if (await readFile(target).then(old => old.equals(bytes), () => false)) continue
    await mkdir(dirname(target), { recursive: true })
    await (typeof content === 'string' ? writeFile(target, bytes) : copyFile(content.copy, target))
    changed = true
  }
  if (!changed) return
  const run = (command: string, args: string[]) => new Promise<void>(resolve => execFile(command, args, () => resolve()))
  await run('update-mime-database', [join(data, 'mime')])
  if (appImage) await run('update-desktop-database', [join(data, 'applications')])
}

export function mimeXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME}">
    <comment>Cascade project</comment>
    <glob pattern="*.cascade"/>
    <icon name="${MIME_ICON}"/>
  </mime-type>
</mime-info>
`
}

/** Desktop entry launching the AppImage at `appImage`; Exec quoting per the Desktop Entry spec. */
export function desktopEntry(appImage: string): string {
  const exec = `"${appImage.replace(/[\\"`$]/g, c => `\\${c}`)}"`
  return `[Desktop Entry]
Name=Cascade
Exec=${exec.replace(/\\/g, '\\\\')} %U
Terminal=false
Type=Application
Icon=cascade
StartupWMClass=cascade
MimeType=${MIME};
Categories=AudioVideo;
`
}
