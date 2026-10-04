import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openWebDb, type WebDb } from './storage/idb'
import {
  DraftManager,
  createDraftManager,
} from './drafts'

describe('DraftManager', () => {
  let factory: IDBFactory
  let db: WebDb
  let manager: DraftManager

  beforeEach(async () => {
    factory = new IDBFactory()
    db = await openWebDb({ factory })
    manager = createDraftManager({ db })
  })

  it('saves, retrieves, and deletes sealed drafts in db.drafts', async () => {
    expect(await manager.isDirty()).toBe(false)
    const sealed = new Uint8Array([1, 2, 3, 4])
    await manager.saveDraft('entry-1', sealed)

    expect(await manager.isDirty()).toBe(true)
    const stored = await manager.getDraft('entry-1')
    expect(stored).toEqual(sealed)

    const list = await manager.listDrafts()
    expect(list).toHaveLength(1)
    expect(list[0].entryId).toBe('entry-1')
    expect(list[0].sealed).toEqual(sealed)

    await manager.deleteDraft('entry-1')
    expect(await manager.isDirty()).toBe(false)
    expect(await manager.getDraft('entry-1')).toBeUndefined()
  })

  it('installs beforeunload listener that warns when dirty', async () => {
    const listeners: Record<string, ((e: BeforeUnloadEvent) => void)[]> = {}
    const mockWindow = {
      addEventListener: (type: string, listener: (e: BeforeUnloadEvent) => void) => {
        listeners[type] = listeners[type] || []
        listeners[type].push(listener)
      },
      removeEventListener: (type: string, listener: (e: BeforeUnloadEvent) => void) => {
        listeners[type] = (listeners[type] || []).filter((l) => l !== listener)
      },
    }

    const cleanup = manager.installBeforeUnload(mockWindow as unknown as Window)
    expect(listeners['beforeunload']).toBeDefined()

    const event = {
      preventDefault: vi.fn(),
      returnValue: '',
    } as unknown as BeforeUnloadEvent

    // Not dirty: no preventDefault / returnValue set
    for (const l of listeners['beforeunload']) {
      l(event)
    }
    expect(event.returnValue).toBe('')

    // Dirty: sets returnValue and calls preventDefault
    await manager.saveDraft('entry-1', new Uint8Array([5, 6]))
    for (const l of listeners['beforeunload']) {
      l(event)
    }
    expect(event.returnValue).toBeDefined()
    expect(event.preventDefault).toHaveBeenCalled()

    cleanup()
    expect(listeners['beforeunload']).toHaveLength(0)
  })
})
