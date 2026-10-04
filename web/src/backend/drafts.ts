/**
 * Drafts Queue and Lifecycle Management (Phase 16.1, retention Phase 16.5).
 *
 *  - Stores sealed ciphertext in IndexedDB (`db.drafts`).
 *  - A draft is KEPT after its upload and marked pushed (`pushedHash`): the overlay is rebuilt
 *    from every draft after a reload, so a pushed-but-unimported edit is never rebuilt from synced
 *    state. Dropping pushed drafts is the deferred 16.1 retention rule (docs/LATER.md).
 *  - "Dirty" = some draft whose `pushedHash` is missing or is not the hash of its `sealed`.
 *  - Provides `beforeunload` warning when there are unpushed drafts.
 *  - Notifies `onDraftSaved` listeners after every stored draft (the debounced push trigger in
 *    `commands/sync.ts`), so the write commands need no push call of their own.
 *  - Dispatches uploads via `safeUpload`.
 */

import type { DraftRecord, WebDb } from './storage/idb'
import { safeUpload, type SafeUploadDeps, type SafeUploadIntent } from './sync/safeUpload'

export interface DraftManagerDeps {
  db: WebDb
}

/** Lowercase SHA-256 hex of `bytes` (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function isUnpushed(rec: DraftRecord): Promise<boolean> {
  const hash: unknown = rec.pushedHash
  return typeof hash !== 'string' || hash !== (await sha256Hex(rec.sealed))
}

// Page-wide dirty state. `entries.ts` builds a new manager per command, so it cannot live on an
// instance. `saveGen` stamps every save, so a refresh or a flush that started before a save never
// clears the id that save made dirty.
const unpushedIds = new Set<string>()
const lastSaveGen = new Map<string, number>()
let saveGen = 0

const savedSince = (entryId: string, gen: number): boolean => (lastSaveGen.get(entryId) ?? 0) > gen

const saveListeners = new Set<() => void>()

/** Calls `listener` after every successful `saveDraft`. Returns the unsubscribe function. */
export function onDraftSaved(listener: () => void): () => void {
  saveListeners.add(listener)
  return () => {
    saveListeners.delete(listener)
  }
}

export class DraftManager {
  readonly #db: WebDb

  constructor(deps: DraftManagerDeps) {
    this.#db = deps.db
  }

  async saveDraft(entryId: string, sealed: Uint8Array): Promise<void> {
    // A plain put: the record has no `pushedHash`, so it is unpushed.
    await this.#db.drafts.put({
      entryId,
      sealed,
      updatedAt: Date.now(),
    })
    saveGen += 1
    lastSaveGen.set(entryId, saveGen)
    unpushedIds.add(entryId)
    for (const listener of [...saveListeners]) listener()
  }

  async getDraft(entryId: string): Promise<Uint8Array | undefined> {
    const rec = await this.#db.drafts.get(entryId)
    return rec?.sealed
  }

  async deleteDraft(entryId: string): Promise<void> {
    await this.#db.drafts.delete(entryId)
    unpushedIds.delete(entryId)
  }

  /** Every draft, pushed or not. Also refreshes the dirty state from IndexedDB. */
  async listDrafts(): Promise<DraftRecord[]> {
    return (await this.#refresh()).all
  }

  /** Drafts not yet uploaded in their current form. Also refreshes the dirty state. */
  async listUnpushedDrafts(): Promise<DraftRecord[]> {
    return (await this.#refresh()).unpushed
  }

  async isDirty(): Promise<boolean> {
    return (await this.listUnpushedDrafts()).length > 0
  }

  /** The last known dirty state, without reading IndexedDB (for `beforeunload`). */
  isDirtySync(): boolean {
    return isAnyDraftDirty()
  }

  installBeforeUnload(windowObj?: Window): () => void {
    const target = windowObj ?? (typeof window !== 'undefined' ? window : undefined)
    if (!target) return () => undefined

    const handler = (e: BeforeUnloadEvent): void => {
      if (isAnyDraftDirty()) {
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
   * Uploads `intents` (packed from `sealed`, the draft bytes the caller read) through
   * `safeUpload`, then marks the draft pushed, only if its stored bytes are still `sealed`: a
   * `saveDraft` during the upload stays unpushed. The caller passes `sealed` rather than this
   * re-reading the record so the recorded hash is the hash of what was actually packed. The draft
   * is never deleted. A rejected upload changes nothing and rethrows.
   */
  async flush(
    entryId: string,
    intents: SafeUploadIntent[],
    uploadDeps: SafeUploadDeps,
    sealed: Uint8Array,
  ): Promise<void> {
    const startGen = saveGen
    const hash = await sha256Hex(sealed)
    await safeUpload(intents, uploadDeps)
    const marked = await this.#db.drafts.markPushed(entryId, sealed, hash)
    if (marked && !savedSince(entryId, startGen)) unpushedIds.delete(entryId)
  }

  async #refresh(): Promise<{ all: DraftRecord[]; unpushed: DraftRecord[] }> {
    const startGen = saveGen
    const all = await this.#db.drafts.list()
    const unpushed: DraftRecord[] = []
    const seen = new Set<string>()
    for (const rec of all) {
      seen.add(rec.entryId)
      if (await isUnpushed(rec)) {
        unpushed.push(rec)
        unpushedIds.add(rec.entryId)
      } else if (!savedSince(rec.entryId, startGen)) {
        unpushedIds.delete(rec.entryId)
      }
    }
    for (const id of [...unpushedIds]) {
      if (!seen.has(id) && !savedSince(id, startGen)) unpushedIds.delete(id)
    }
    return { all, unpushed }
  }
}

let beforeUnloadInstalled = false

export function isAnyDraftDirty(): boolean {
  return unpushedIds.size > 0
}

/** The last known number of unpushed drafts, without reading IndexedDB (`entriesPending`). */
export function unpushedDraftCount(): number {
  return unpushedIds.size
}

export function resetDraftsAutostartForTest(): void {
  unpushedIds.clear()
  lastSaveGen.clear()
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
