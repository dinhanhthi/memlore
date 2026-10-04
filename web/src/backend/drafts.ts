/**
 * Drafts Queue and Lifecycle Management (Phase 16.1).
 *
 *  - Stores sealed ciphertext in IndexedDB (`db.drafts`).
 *  - Holds unpushed intents and media until safeUpload succeeds.
 *  - Provides `beforeunload` warning when there are unsynced drafts.
 *  - Dispatches uploads via `safeUpload`.
 */

import type { DraftRecord, WebDb } from './storage/idb'
import { safeUpload, type SafeUploadDeps, type SafeUploadIntent } from './sync/safeUpload'

export interface DraftManagerDeps {
  db: WebDb
}

export class DraftManager {
  readonly #db: WebDb
  #dirty = false

  constructor(deps: DraftManagerDeps) {
    this.#db = deps.db
  }

  async saveDraft(entryId: string, sealed: Uint8Array): Promise<void> {
    await this.#db.drafts.put({
      entryId,
      sealed,
      updatedAt: Date.now(),
    })
    this.#dirty = true
    activeDirtyManagers.add(this)
  }

  async getDraft(entryId: string): Promise<Uint8Array | undefined> {
    const rec = await this.#db.drafts.get(entryId)
    return rec?.sealed
  }

  async deleteDraft(entryId: string): Promise<void> {
    await this.#db.drafts.delete(entryId)
    const list = await this.#db.drafts.list()
    this.#dirty = list.length > 0
    if (!this.#dirty) activeDirtyManagers.delete(this)
  }

  async listDrafts(): Promise<DraftRecord[]> {
    const list = await this.#db.drafts.list()
    this.#dirty = list.length > 0
    return list
  }

  async isDirty(): Promise<boolean> {
    const list = await this.#db.drafts.list()
    this.#dirty = list.length > 0
    return this.#dirty
  }

  isDirtySync(): boolean {
    return this.#dirty
  }

  installBeforeUnload(windowObj?: Window): () => void {
    const target =
      windowObj ?? (typeof window !== 'undefined' ? window : undefined)
    if (!target) return () => undefined

    const handler = (e: BeforeUnloadEvent): void => {
      if (this.#dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    target.addEventListener('beforeunload', handler)
    return () => {
      target.removeEventListener('beforeunload', handler)
    }
  }

  /**
   * Flushes a set of prepared `SafeUploadIntent[]` through `safeUpload`.
   * On success, cleans up the draft record for entryId.
   */
  async flush(
    entryId: string,
    intents: SafeUploadIntent[],
    uploadDeps: SafeUploadDeps,
  ): Promise<void> {
    await safeUpload(intents, uploadDeps)
    await this.deleteDraft(entryId)
  }
}

const activeDirtyManagers = new Set<DraftManager>()
let beforeUnloadInstalled = false

export function isAnyDraftDirty(): boolean {
  return activeDirtyManagers.size > 0
}

export function resetDraftsAutostartForTest(): void {
  activeDirtyManagers.clear()
}

export function installDraftsAutostart(windowObj?: Window): () => void {
  const target = windowObj ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target || beforeUnloadInstalled) return () => undefined
  beforeUnloadInstalled = true

  const handler = (e: BeforeUnloadEvent): void => {
    if (isAnyDraftDirty()) {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  target.addEventListener('beforeunload', handler)
  return () => {
    target.removeEventListener('beforeunload', handler)
    beforeUnloadInstalled = false
  }
}

export function createDraftManager(deps: DraftManagerDeps): DraftManager {
  return new DraftManager(deps)
}
