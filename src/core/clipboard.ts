import type { CascadeAPI } from './app'
import type { Contribution } from './registry'
import type { Id } from '@shared/project'

/** Explicit targets override a format's current UI selection. */
export interface ClipboardContext {
  ids?: Id[]
  property?: { clipId?: Id; propertyId?: Id }
}
export interface ClipboardFormatContribution extends Contribution {
  remove?(app: CascadeAPI, data: unknown): void
  canCopy(app: CascadeAPI, context?: ClipboardContext): boolean
  copy(app: CascadeAPI, context?: ClipboardContext): unknown | Promise<unknown>
  canPaste(app: CascadeAPI, data: unknown, context?: ClipboardContext): boolean
  paste(app: CascadeAPI, data: unknown, opts: { insert: boolean; context?: ClipboardContext }): Id[] | void | Promise<Id[] | void>
  /** Decode a legacy wire format owned by this plugin. Return null for unrecognized text. */
  decode?(text: string): unknown | null
}
export interface FormatClipboardPayload { cascade: 1; format: string; data: unknown }
export type ClipboardPayload = FormatClipboardPayload
export function parseClipboard(text: string): ClipboardPayload | null {
  try {
    const v = JSON.parse(text)
    return v && v.cascade === 1 && typeof v.format === 'string' && v.format.length && Object.hasOwn(v, 'data') ? v : null
  } catch { return null }
}
export const clipboardFormats = (app: CascadeAPI) => app.registries.clipboardFormats.all().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
export class ClipboardService {
  private payload: ClipboardPayload | null = null
  constructor(private app: CascadeAPI) {}
  private async write(payload: ClipboardPayload): Promise<void> {
    this.payload = clone(payload)
    try { await globalThis.navigator?.clipboard?.writeText(JSON.stringify(payload)) }
    catch { this.app.notify('warning', 'System clipboard unavailable; copied inside this window') }
  }
  async read(): Promise<ClipboardPayload | null> {
    try {
      if (globalThis.navigator?.clipboard) {
        const text = await navigator.clipboard.readText()
        this.payload = parseClipboard(text)
        if (!this.payload) for (const format of clipboardFormats(this.app)) {
          const data = format.decode?.(text)
          if (data != null) { this.payload = { cascade: 1, format: format.id, data }; break }
        }
      }
    } catch { /* Keep the in-memory clipboard when OS access is denied. */ }
    return this.payload ? clone(this.payload) : null
  }
  private async copyContext(context?: ClipboardContext, cut = false): Promise<void> {
    const format = clipboardFormats(this.app).find(f => f.canCopy(this.app, context))
    if (!format || cut && !format.remove) return
    const snapshot = this.app.project()
    const data = await format.copy(this.app, context)
    if (data == null) return
    await this.write({ cascade: 1, format: format.id, data })
    if (cut && this.app.project() === snapshot) format.remove!(this.app, data)
  }
  async copy(ids?: Id[]): Promise<void> { await this.copyContext(ids ? { ids } : undefined) }
  async cut(ids?: Id[]): Promise<void> { await this.copyContext(ids ? { ids } : undefined, true) }
  private async pasteContext(insert: boolean, context?: ClipboardContext): Promise<Id[]> {
    const payload = await this.read()
    if (!payload) return []
    const format = clipboardFormats(this.app).find(f => f.id === payload.format && f.canPaste(this.app, payload.data, context))
    return format ? await format.paste(this.app, payload.data, { insert, context }) ?? [] : []
  }
  async paste(insert = false): Promise<Id[]> { return this.pasteContext(insert) }
  async copyProperty(clipId: Id, propertyId: Id): Promise<void> { await this.copyContext({ property: { clipId, propertyId } }) }
  async pasteProperty(ids = this.app.selection.clips.get()): Promise<void> { await this.pasteContext(false, { ids, property: {} }) }
}
