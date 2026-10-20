import { ipcMain } from 'electron'

export function registerExportIpc(): void {
  for (const channel of ['export:start', 'export:cancel', 'export:frame']) {
    ipcMain.handle(channel, () => { throw new Error('export not implemented yet') })
  }
}
