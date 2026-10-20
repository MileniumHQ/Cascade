import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, type Project } from '@shared/project'
import { DocumentStore } from './document'

function project(name = 'Untitled'): Project {
  return createProject(name)
}

function snap(doc: DocumentStore): Project {
  return structuredClone(doc.state)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DocumentStore transact', () => {
  it('replaces state immutably and freezes the result', () => {
    const doc = new DocumentStore(project('Original'))
    const initial = doc.state
    expect(Object.isFrozen(initial)).toBe(false)

    const changed = doc.transact('Rename', (d) => {
      d.name = 'Next'
      d.settings.width = 1280
    })

    expect(changed).toBe(true)
    expect(doc.state).not.toBe(initial)
    expect(initial.name).toBe('Original')
    expect(initial.settings.width).toBe(1920)
    expect(doc.state.name).toBe('Next')
    expect(doc.state.settings.width).toBe(1280)
    expect(Object.isFrozen(doc.state)).toBe(true)
    expect(() => {
      doc.state.name = 'mutated'
    }).toThrow(TypeError)

    const mid = doc.state
    doc.transact('Background', (d) => {
      d.settings.background = '#ffffff'
    })
    expect(mid.settings.background).toBe('#000000')
    expect(doc.state.settings.background).toBe('#ffffff')
    expect(mid.name).toBe('Next')
  })

  it('does not record a transaction that changes nothing', () => {
    const doc = new DocumentStore(project())
    doc.transact('Rename', (d) => {
      d.name = 'A'
    })
    doc.undo()
    expect(doc.canRedo).toBe(true)
    const events: string[] = []
    doc.onChange.on((e) => events.push(e.source))

    expect(doc.transact('noop', (d) => {
      d.name = d.name
    })).toBe(false)
    expect(doc.canRedo).toBe(true)
    expect(events).toEqual([])
  })
})

describe('undo / redo', () => {
  it('restores nested state exactly in both directions', () => {
    const doc = new DocumentStore(project('Original'))
    const s0 = snap(doc)

    doc.transact('Rename', (d) => {
      d.name = 'Renamed'
      d.settings.width = 1280
      d.settings.fps = { num: 24, den: 1 }
    })
    const s1 = snap(doc)

    doc.transact('Mark', (d) => {
      const tl = d.timelines[d.activeTimeline]
      tl.tracks[0].name = 'Video 1'
      tl.markers.push({ id: 'm1', t: 0, name: 'In' })
      d.settings.background = '#111111'
    })
    const s2 = snap(doc)

    expect(doc.undo()).toBe(true)
    expect(doc.state).toEqual(s1)
    expect(doc.undo()).toBe(true)
    expect(doc.state).toEqual(s0)
    expect(doc.canUndo).toBe(false)
    expect(doc.undo()).toBe(false)

    expect(doc.redo()).toBe(true)
    expect(doc.state).toEqual(s1)
    expect(doc.redo()).toBe(true)
    expect(doc.state).toEqual(s2)
    expect(doc.canRedo).toBe(false)
    expect(doc.redo()).toBe(false)
  })

  it('drops the redo stack when a new edit is made', () => {
    const doc = new DocumentStore(project('A'))
    doc.transact('to B', (d) => {
      d.name = 'B'
    })
    doc.transact('to C', (d) => {
      d.name = 'C'
    })
    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('B')
    expect(doc.canRedo).toBe(true)
    expect(doc.redoLabel).toBe('to C')

    doc.transact('to D', (d) => {
      d.name = 'D'
    })
    expect(doc.canRedo).toBe(false)
    expect(doc.redo()).toBe(false)
    expect(doc.state.name).toBe('D')
    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('B')
  })
})

describe('coalesce', () => {
  it('merges consecutive transactions with the same key inside one gesture', () => {
    const doc = new DocumentStore(project('A'))
    const original = snap(doc)

    doc.beginGesture('scrub')
    doc.transact('scrub 1', (d) => {
      d.name = 'B'
    }, { coalesce: 'scrub' })
    doc.transact('scrub 2', (d) => {
      d.settings.width = 100
    }, { coalesce: 'scrub' })
    doc.transact('scrub 3', (d) => {
      d.settings.height = 50
    }, { coalesce: 'scrub' })
    doc.endGesture()

    expect(doc.state).toMatchObject({ name: 'B', settings: { width: 100, height: 50 } })
    expect(doc.undoLabel).toBe('scrub 1')
    expect(doc.undo()).toBe(true)
    expect(doc.state).toEqual(original)
    expect(doc.canUndo).toBe(false)
    expect(doc.redo()).toBe(true)
    expect(doc.state).toMatchObject({ name: 'B', settings: { width: 100, height: 50 } })
  })

  it('keeps gestures with different coalesce keys as separate undo steps', () => {
    const doc = new DocumentStore(project('A'))
    doc.beginGesture('width')
    doc.transact('width', (d) => {
      d.settings.width = 100
    }, { coalesce: 'width' })
    doc.endGesture()
    doc.beginGesture('height')
    doc.transact('height', (d) => {
      d.settings.height = 50
    }, { coalesce: 'height' })
    doc.endGesture()

    expect(doc.undo()).toBe(true)
    expect(doc.state.settings.height).toBe(1080)
    expect(doc.state.settings.width).toBe(100)
    expect(doc.undo()).toBe(true)
    expect(doc.state.settings.width).toBe(1920)
  })

  it('does not time-merge onto a gesture after endGesture', () => {
    const doc = new DocumentStore(project('Base'))
    doc.beginGesture('type')
    doc.transact('type', (d) => {
      d.name = 'Typed'
    }, { coalesce: 'type' })
    doc.endGesture()
    doc.transact('type', (d) => {
      d.name = 'More'
    }, { coalesce: 'type' })

    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('Typed')
    expect(doc.canUndo).toBe(true)
  })

  it('merges the same coalesce key within 800ms and starts a new step after that', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const doc = new DocumentStore(project('Base'))

    doc.transact('type', (d) => {
      d.name = 'A'
    }, { coalesce: 'type' })
    vi.advanceTimersByTime(799)
    doc.transact('type', (d) => {
      d.name = 'B'
    }, { coalesce: 'type' })
    vi.advanceTimersByTime(800)
    doc.transact('type', (d) => {
      d.name = 'C'
    }, { coalesce: 'type' })

    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('B')
    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('Base')
    expect(doc.canUndo).toBe(false)
  })

  it('stores a later gesture that reuses the coalesce key as its own undo step', () => {
    // Regression: endGesture() must seal the entry so the next same-key gesture is its own step.
    const doc = new DocumentStore(project('Base'))
    doc.transact('base', (d) => {
      d.name = 'Base'
    })
    doc.beginGesture('scrub')
    doc.transact('scrub 1', (d) => {
      d.settings.width = 100
    }, { coalesce: 'scrub' })
    doc.endGesture()
    doc.beginGesture('scrub')
    doc.transact('scrub 2', (d) => {
      d.settings.width = 200
    }, { coalesce: 'scrub' })
    doc.endGesture()

    expect(doc.state.settings.width).toBe(200)
    expect(doc.undo()).toBe(true)
    expect(doc.state.settings.width).toBe(100)
    expect(doc.state.name).toBe('Base')
    expect(doc.undo()).toBe(true)
    expect(doc.state.settings.width).toBe(1920)
    expect(doc.state.name).toBe('Base')
    // The 'base' transaction was a no-op (name already 'Base'), so nothing else is on the stack.
    expect(doc.canUndo).toBe(false)
  })
})

describe('dirty / markSaved', () => {
  it('tracks dirtiness against the saved history entry', () => {
    const doc = new DocumentStore(project('A'))
    expect(doc.dirty).toBe(false)

    doc.markSaved()
    expect(doc.dirty).toBe(false)

    doc.transact('A', (d) => {
      d.name = 'A1'
    })
    expect(doc.dirty).toBe(true)
    doc.markSaved()
    expect(doc.dirty).toBe(false)

    doc.transact('B', (d) => {
      d.name = 'B'
    })
    expect(doc.dirty).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('A1')
    expect(doc.dirty).toBe(false)

    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('A')
    expect(doc.dirty).toBe(true)

    expect(doc.redo()).toBe(true)
    expect(doc.dirty).toBe(false)
    expect(doc.redo()).toBe(true)
    expect(doc.state.name).toBe('B')
    expect(doc.dirty).toBe(true)
  })

  it('does not coalesce a new edit into the entry that was just saved', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const doc = new DocumentStore(project('Base'))
    doc.transact('type', (d) => {
      d.name = 'A'
    }, { coalesce: 'type' })
    doc.markSaved()
    vi.advanceTimersByTime(10)
    doc.transact('type', (d) => {
      d.name = 'B'
    }, { coalesce: 'type' })

    expect(doc.dirty).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.state.name).toBe('A')
    expect(doc.dirty).toBe(false)
    expect(doc.canUndo).toBe(true)
  })
})

describe('onChange', () => {
  it('emits edit, undo, and redo with the transaction label', () => {
    const doc = new DocumentStore(project('A'))
    const events: { source: string; label: string; name: string }[] = []
    doc.onChange.on((e) => {
      events.push({ source: e.source, label: e.label, name: doc.state.name })
    })

    doc.transact('Rename', (d) => {
      d.name = 'B'
    })
    doc.undo()
    doc.redo()

    expect(events).toEqual([
      { source: 'edit', label: 'Rename', name: 'B' },
      { source: 'undo', label: 'Rename', name: 'A' },
      { source: 'redo', label: 'Rename', name: 'B' }
    ])
    expect(events.every((e) => e.source === 'edit' || e.source === 'undo' || e.source === 'redo')).toBe(true)
  })

  it('emits one edit per coalesced transaction and one undo for the whole gesture', () => {
    const doc = new DocumentStore(project('A'))
    const sources: string[] = []
    doc.onChange.on((e) => sources.push(e.source))

    doc.beginGesture('g')
    doc.transact('one', (d) => {
      d.name = 'B'
    }, { coalesce: 'g' })
    doc.transact('two', (d) => {
      d.settings.width = 10
    }, { coalesce: 'g' })
    doc.endGesture()
    doc.undo()

    expect(sources).toEqual(['edit', 'edit', 'undo'])
    expect(doc.state.name).toBe('A')
    expect(doc.state.settings.width).toBe(1920)
  })
})
