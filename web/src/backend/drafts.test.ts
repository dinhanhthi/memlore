import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openWebDb, type WebDb } from './storage/idb'
import type { SafeUploadDeps } from './sync/safeUpload'
import {
  DraftManager,
  createDraftManager,
  isAnyDraftDirty,
  onDraftSaved,
  resetDraftsAutostartForTest,
  sha256Hex,
  unpushedDraftCount,
} from './drafts'

const mocks = vi.hoisted(() => ({
  safeUpload: vi.fn(
    async (_intents: unknown, _deps: SafeUploadDeps): Promise<unknown> => undefined,
  ),
}))
vi.mock('./sync/safeUpload', () => ({ safeUpload: mocks.safeUpload }))

const UPLOAD_DEPS = {} as SafeUploadDeps

describe('DraftManager', () => {
  let factory: IDBFactory
  let db: WebDb
  let manager: DraftManager

  beforeEach(async () => {
    factory = new IDBFactory()
    db = await openWebDb({ factory })
    manager = createDraftManager({ db })
    resetDraftsAutostartForTest()
    mocks.safeUpload.mockReset()
    mocks.safeUpload.mockResolvedValue(undefined)
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

  it('flush keeps the draft and marks it pushed', async () => {
    const sealed = new Uint8Array([1, 2, 3])
    await manager.saveDraft('e1', sealed)
    expect(isAnyDraftDirty()).toBe(true)

    await manager.flush('e1', [], UPLOAD_DEPS, sealed)

    expect(mocks.safeUpload).toHaveBeenCalledTimes(1)
    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(sealed)
    expect(rec?.pushedHash).toBe(await sha256Hex(sealed))
    expect(await manager.listUnpushedDrafts()).toEqual([])
    expect(isAnyDraftDirty()).toBe(false)
    expect(manager.isDirtySync()).toBe(false)
  })

  it('a saveDraft that lands during the upload stays unpushed', async () => {
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])
    await manager.saveDraft('e1', first)
    let release!: () => void
    mocks.safeUpload.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    )

    const flushing = manager.flush('e1', [], UPLOAD_DEPS, first)
    await vi.waitFor(() => expect(mocks.safeUpload).toHaveBeenCalled())
    // Another command instance, as entries.ts creates one per call.
    await createDraftManager({ db }).saveDraft('e1', second)
    release()
    await flushing

    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(second)
    expect(rec?.pushedHash).toBeUndefined()
    expect((await manager.listUnpushedDrafts()).map((d) => d.entryId)).toEqual(['e1'])
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('a safeUpload rejection leaves the draft unpushed and rethrows', async () => {
    const sealed = new Uint8Array([9])
    await manager.saveDraft('e1', sealed)
    mocks.safeUpload.mockRejectedValueOnce(new Error('refused'))

    await expect(manager.flush('e1', [], UPLOAD_DEPS, sealed)).rejects.toThrow('refused')

    expect(await db.drafts.get('e1')).toMatchObject({ entryId: 'e1', sealed })
    expect((await db.drafts.get('e1'))?.pushedHash).toBeUndefined()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('counts an old record without pushedHash, or with a stale one, as unpushed', async () => {
    await db.drafts.put({ entryId: 'old', sealed: new Uint8Array([1]), updatedAt: 1 })
    await db.drafts.put({
      entryId: 'stale',
      sealed: new Uint8Array([2]),
      updatedAt: 1,
      pushedHash: await sha256Hex(new Uint8Array([3])),
    })
    await db.drafts.put({
      entryId: 'pushed',
      sealed: new Uint8Array([4]),
      updatedAt: 1,
      pushedHash: await sha256Hex(new Uint8Array([4])),
    })

    const unpushed = await manager.listUnpushedDrafts()
    expect(unpushed.map((d) => d.entryId).sort()).toEqual(['old', 'stale'])
    expect(await manager.isDirty()).toBe(true)
  })

  it('is dirty after a reload: a new manager over an IDB that already holds an unpushed draft', async () => {
    await db.drafts.put({ entryId: 'e1', sealed: new Uint8Array([1]), updatedAt: 1 })
    // A fresh page: module state is empty, no saveDraft ran.
    resetDraftsAutostartForTest()
    const reloaded = await openWebDb({ factory })
    const fresh = createDraftManager({ db: reloaded })
    expect(isAnyDraftDirty()).toBe(false)

    await fresh.listDrafts()

    expect(isAnyDraftDirty()).toBe(true)
    expect(fresh.isDirtySync()).toBe(true)
  })

  it('notifies save listeners once per stored draft, until unsubscribed', async () => {
    const saved = vi.fn()
    const off = onDraftSaved(saved)
    await manager.saveDraft('e1', new Uint8Array([1]))
    expect(saved).toHaveBeenCalledTimes(1)
    off()
    await manager.saveDraft('e1', new Uint8Array([2]))
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the draft could not be stored', async () => {
    const saved = vi.fn()
    const off = onDraftSaved(saved)
    vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('quota'))
    await expect(manager.saveDraft('e1', new Uint8Array([1]))).rejects.toThrow('quota')
    expect(saved).not.toHaveBeenCalled()
    off()
  })

  it('counts the unpushed drafts without reading IndexedDB', async () => {
    expect(unpushedDraftCount()).toBe(0)
    await manager.saveDraft('e1', new Uint8Array([1]))
    await manager.saveDraft('e2', new Uint8Array([2]))
    expect(unpushedDraftCount()).toBe(2)
    await manager.flush('e1', [], UPLOAD_DEPS, new Uint8Array([1]))
    expect(unpushedDraftCount()).toBe(1)
  })

  it('flush writes nothing and leaves the draft unmarked when it changed before the lock', async () => {
    const older = new Uint8Array([1])
    const newer = new Uint8Array([2])
    await manager.saveDraft('e1', older)
    let checked: boolean | undefined
    mocks.safeUpload.mockImplementationOnce(async (_intents, deps) => {
      // Another tab saves while this batch waits on the writer lock.
      await createDraftManager({ db }).saveDraft('e1', newer)
      checked = await deps.beforeWrite?.()
      if (checked === false) throw new Error('stale')
      return undefined
    })

    expect(await manager.flush('e1', [], UPLOAD_DEPS, older)).toBe('stale')

    expect(checked).toBe(false)
    const rec = await db.drafts.get('e1')
    expect(rec?.sealed).toEqual(newer)
    expect(rec?.pushedHash).toBeUndefined()
    expect(isAnyDraftDirty()).toBe(true)
  })

  it('flush reports pushed when the stored draft still holds the uploaded bytes', async () => {
    const sealed = new Uint8Array([3])
    await manager.saveDraft('e1', sealed)
    let checked: boolean | undefined
    mocks.safeUpload.mockImplementationOnce(async (_intents, deps) => {
      checked = await deps.beforeWrite?.()
      return undefined
    })

    expect(await manager.flush('e1', [], UPLOAD_DEPS, sealed)).toBe('pushed')
    expect(checked).toBe(true)
  })
})
