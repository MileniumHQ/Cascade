export interface Disposable {
  dispose(): void
}

export const toDisposable = (fn: () => void): Disposable => {
  let done = false
  return {
    dispose() {
      if (done) return
      done = true
      fn()
    }
  }
}

/** Collects disposables and disposes them in reverse order. */
export class DisposableStore implements Disposable {
  private items: Disposable[] = []
  private disposed = false
  add<T extends Disposable>(d: T): T {
    if (this.disposed) d.dispose()
    else this.items.push(d)
    return d
  }
  dispose() {
    this.disposed = true
    const items = this.items.reverse()
    this.items = []
    for (const d of items) {
      try {
        d.dispose()
      } catch (e) {
        console.error('[cascade] dispose failed', e)
      }
    }
  }
}
