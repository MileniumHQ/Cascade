import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze, type Draft, type Patch } from 'immer'
import type { Project } from '@shared/project'
import { Emitter } from './events'

enablePatches()
setAutoFreeze(true)

export interface ChangeEvent {
  patches: Patch[]
  label: string
  source: 'edit' | 'undo' | 'redo' | 'load'
}

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  coalesce?: string
  at: number
}

export interface TransactOptions {
  /**
   * Transactions with the same coalesce key merge into one undo step while a gesture is open,
   * or within 800 ms of each other (e.g. typing in a field).
   */
  coalesce?: string
  /** Don't record in history (e.g. transient UI state stored in pluginData). */
  silent?: boolean
}

/**
 * The single source of truth for the open project. Immutable (immer) state; every change is a
 * transaction producing patches, which gives undo/redo, change events for the UI, and a precise
 * change feed for agents (MCP) and future collaboration.
 */
export class DocumentStore {
  private _state: Project
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private gestureKey: string | null = null
  private savedMarker: HistoryEntry | null = null
  readonly onChange = new Emitter<ChangeEvent>()
  readonly onHistory = new Emitter<void>()

  constructor(initial: Project) {
    this._state = initial
  }

  get state(): Project {
    return this._state
  }

  /** Replace the whole project (open/new). Clears history. */
  load(project: Project) {
    this._state = project
    this.undoStack = []
    this.redoStack = []
    this.savedMarker = null
    this.onChange.emit({ patches: [], label: 'load', source: 'load' })
    this.onHistory.emit()
  }

  transact(label: string, recipe: (draft: Draft<Project>) => void, opts: TransactOptions = {}): boolean {
    const [next, patches, inverse] = produceWithPatches(this._state, (d) => {
      recipe(d)
    })
    if (patches.length === 0) return false
    this._state = next
    if (!opts.silent) {
      const last = this.undoStack[this.undoStack.length - 1]
      const now = Date.now()
      const canMerge =
        last &&
        opts.coalesce &&
        last.coalesce === opts.coalesce &&
        (this.gestureKey === opts.coalesce || now - last.at < 800) &&
        last !== this.savedMarker
      if (canMerge) {
        last.patches.push(...patches)
        last.inverse.unshift(...inverse)
        last.at = now
      } else {
        this.undoStack.push({ label, patches, inverse, coalesce: opts.coalesce, at: now })
        if (this.undoStack.length > 500) this.undoStack.shift()
      }
      this.redoStack = []
      this.onHistory.emit()
    }
    this.onChange.emit({ patches, label, source: 'edit' })
    return true
  }

  /** Group subsequent transactions with `key` into a single undo step until endGesture(). */
  beginGesture(key: string) {
    this.gestureKey = key
  }
  endGesture() {
    this.gestureKey = null
    const last = this.undoStack[this.undoStack.length - 1]
    if (last) {
      // Seal the step: neither time-based nor same-key merging with the next gesture.
      last.at = 0
      last.coalesce = undefined
    }
  }

  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this._state = applyPatches(this._state, entry.inverse)
    this.redoStack.push(entry)
    this.onChange.emit({ patches: entry.inverse, label: entry.label, source: 'undo' })
    this.onHistory.emit()
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this._state = applyPatches(this._state, entry.patches)
    this.undoStack.push(entry)
    this.onChange.emit({ patches: entry.patches, label: entry.label, source: 'redo' })
    this.onHistory.emit()
    return true
  }

  markSaved() {
    this.savedMarker = this.undoStack[this.undoStack.length - 1] ?? null
    this.onHistory.emit()
  }

  get dirty() {
    return (this.undoStack[this.undoStack.length - 1] ?? null) !== this.savedMarker
  }
}
