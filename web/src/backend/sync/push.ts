/**
 * Push: uploads the unpushed drafts to this device's outbox (Phase 16.5).
 *
 * `pushAll()` is the web companion's only write path after onboarding. Every upload goes through
 * `safeUpload` (write flag, clock, fence, format guard, allowlist, seal-then-verify, under the Web
 * Lock); the one other write is `safeEnsureOutboxFolder` (`<webId>` and `<webId>/outbox` only),
 * once per session, behind the same checks. Nothing is ever deleted, on Drive or in IndexedDB.
 *
 * Session (one per unlock, dropped by the lock hook):
 *  - `ExpectedVaultState` comes from the device record (`recoveryGeneration`, `masterFingerprint`)
 *    and the `_meta.json` text cached pinned at onboarding (`epoch`, `contentEpoch`). Missing,
 *    unparsable or disagreeing with the record: `MissingVaultStateError` (re-onboard). A fresh read
 *    of `_meta.json` is never trusted as "expected": the fence compares against it.
 *  - One writer with `{ownId: deviceId, localGen: recoveryGeneration}`.
 *
 * A run, for each unpushed draft (oldest `updatedAt` first): open it, open its outbox media and
 * thumbs from `blobs` (the seal-then-verify plaintext), pack, `DraftManager.flush`.
 *  - Draft or media that cannot be opened, or missing outbox media: that entry is skipped (logged,
 *    kept). Seal-then-verify failure (`SealVerifyError`): that entry is skipped. A draft whose
 *    stored bytes changed before its batch got the lock (another tab saved it): skipped, unmarked,
 *    nothing written; the newer draft is pushed by the run its save triggered.
 *  - Anything else (write flag, fence, clock, format guard, Drive errors, a lock): the run stops,
 *    every remaining draft stays unpushed, and the error is returned as `error`.
 *
 * `pushAll()` never rejects. Locked: a no-op (`{pushed: 0, skipped: 0, pending: 0}`). Cached write
 * flag off: returns without touching Drive. Single-flight per tab: a call during a run returns ONE
 * shared follow-up run, so a save made during a push is pushed by it. The Web Lock serializes tabs.
 *
 * Heavy modules are imported lazily by the default env, so importing this file has no side effects.
 */

import type { Core } from '../../core/core'
import { getCachedWriteFlag } from '../config'
import type { DriveReader, DriveWriterDeps } from '../drive/client'
import { createDraftManager, type DraftManager } from '../drafts'
import { VaultLockedError, getKeyRing, isUnlocked, onLock, type KeyRing } from '../keys'
import { OUTBOX_BLOB_PREFIX, type DraftRecord, type WebDb } from '../storage/idb'
import type { ExpectedVaultState } from './fence'
import { META_PATH, parseMetaText, readVersions, type MetaState } from './onboard'
import { packOutboxUploadIntents, type OutboxEntryV1 } from './outbox'
import {
  SealVerifyError,
  createOutboxWriter,
  safeEnsureOutboxFolder,
  type SafeUploadDeps,
  type SafeUploadIntent,
} from './safeUpload'

export interface PushResult {
  /** Drafts uploaded by this run. */
  pushed: number
  /** Drafts this run skipped (cannot be opened, missing media, seal-then-verify, stale). Kept. */
  skipped: number
  /** Unpushed drafts after the run. */
  pending: number
  /** Why the run stopped early. Every draft not yet pushed is kept. */
  error?: unknown
}

/** The cached vault state cannot build a fence: the user must re-onboard this browser. */
export class MissingVaultStateError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(
      `Cannot push web edits: ${detail}. Reconnect Google Drive and re-onboard this browser with the recovery phrase.`,
      { cause },
    )
    this.name = 'MissingVaultStateError'
  }
}

export interface PushDeps {
  db: WebDb
  reader: DriveReader
  core: Core
  /** Transport for the session's writer (token, fetch, locks). */
  driveDeps: DriveWriterDeps
  /** Default `fetchWriteFlag` (inside `safeUpload`). */
  fetchWriteFlagImpl?: () => Promise<boolean>
  revalidatePull?: () => Promise<void> | void
}

export interface PushEnv {
  isUnlocked: () => boolean
  /** The last fetched write flag (`getCachedWriteFlag`). Off: no Drive call at all. */
  cachedWriteFlag: () => boolean
  /** Built once per unlock. */
  deps: () => Promise<PushDeps>
}

function defaultEnv(): PushEnv {
  return { isUnlocked, cachedWriteFlag: getCachedWriteFlag, deps: buildDeps }
}

let injected: Partial<PushEnv> = {}
const pushEnv = (): PushEnv => ({ ...defaultEnv(), ...injected })

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configurePushEnv(partial: Partial<PushEnv>): void {
  injected = partial
  resetSession()
}

async function buildDeps(): Promise<PushDeps> {
  const [{ openWebDb }, { DriveReader }, { oauth }, { readEnv }, core] = await Promise.all([
    import('../storage/idb'),
    import('../drive/client'),
    import('../drive/oauth'),
    import('../commands/readSession'),
    import('../../core/core').then((m) => m.loadCore()),
  ])
  const driveDeps: DriveWriterDeps = {
    getToken: () => oauth.getAccessToken(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }
  return {
    db: await openWebDb(),
    reader: new DriveReader(driveDeps),
    core,
    driveDeps,
    // A fence refusal re-validates through the read session's pull (it never writes).
    revalidatePull: async () => {
      await (await readEnv().session()).pull()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Session (per unlock)
// ---------------------------------------------------------------------------------------------

interface Prepared {
  writer: SafeUploadDeps['writer']
  expected: ExpectedVaultState
  ownId: string
  localGen: number
}

interface PushSession {
  deps: PushDeps
  drafts: DraftManager
  /** Set once the vault state is validated and the writer built. */
  prepared: Prepared | null
  /** The outbox folder was ensured in this session. */
  folderReady: boolean
}

let session: Promise<PushSession> | null = null
let unhook: (() => void) | null = null
// Bumped by the lock hook: a run that started before a lock stops at its next step.
let epoch = 0

function resetSession(): void {
  epoch += 1
  session = null
  unhook?.()
  unhook = null
}

function getSession(): Promise<PushSession> {
  if (session === null) {
    unhook ??= onLock(resetSession)
    const building = pushEnv()
      .deps()
      .then((deps) => ({
        deps,
        drafts: createDraftManager({ db: deps.db }),
        prepared: null,
        folderReady: false,
      }))
    building.catch(() => {
      if (session === building) session = null
    })
    session = building
  }
  return session
}

/** Validates the cached vault state against the device record, then builds the writer. */
async function prepare(s: PushSession): Promise<Prepared> {
  if (s.prepared !== null) return s.prepared
  const { db, core, reader, driveDeps } = s.deps
  const record = await db.device.get()
  if (record === undefined) throw new MissingVaultStateError('this browser has no device record')
  const cached = await db.files.get(META_PATH)
  if (cached === undefined) throw new MissingVaultStateError('the cached _meta.json is missing')
  let meta: MetaState
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(cached.ciphertext)
    meta = parseMetaText(core, readVersions(core), text)
  } catch (error) {
    throw new MissingVaultStateError('the cached _meta.json cannot be parsed', error)
  }
  if (
    meta.masterFingerprint !== record.masterFingerprint ||
    meta.recoveryGeneration !== record.recoveryGeneration
  ) {
    throw new MissingVaultStateError('the cached _meta.json does not match this device')
  }
  const identity = { ownId: record.deviceId, localGen: record.recoveryGeneration }
  s.prepared = {
    writer: createOutboxWriter(reader, driveDeps, identity),
    expected: {
      recoveryGeneration: record.recoveryGeneration,
      masterFingerprint: record.masterFingerprint,
      epoch: meta.epoch,
      contentEpoch: meta.contentEpoch,
    },
    ...identity,
  }
  return s.prepared
}

function uploadDeps(s: PushSession, p: Prepared, ring: KeyRing): SafeUploadDeps {
  return {
    writer: p.writer,
    reader: s.deps.reader,
    core: s.deps.core,
    ring,
    localGen: p.localGen,
    ownDeviceId: p.ownId,
    expectedFence: p.expected,
    fetchWriteFlagImpl: s.deps.fetchWriteFlagImpl,
    revalidatePull: s.deps.revalidatePull,
  }
}

// ---------------------------------------------------------------------------------------------
// One draft
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openEntry(core: Core, ring: KeyRing, draft: DraftRecord): OutboxEntryV1 {
  const parsed = JSON.parse(core.openOutboxEntry(ring, draft.sealed)) as unknown
  if (
    !isRecord(parsed) ||
    parsed.entry_id !== draft.entryId ||
    !isRecord(parsed.fields) ||
    !Array.isArray(parsed.media)
  ) {
    throw new Error('not an outbox intent for this entry')
  }
  return parsed as unknown as OutboxEntryV1
}

/** The sealed outbox blob at `path` and its plaintext (throws when missing or unopenable). */
async function openBlob(
  s: PushSession,
  ring: KeyRing,
  path: string,
): Promise<{ sealed: Uint8Array; plain: Uint8Array }> {
  const rec = await s.deps.db.blobs.get(path)
  if (rec === undefined) throw new Error(`outbox media ${path} is missing`)
  return { sealed: rec.bytes, plain: s.deps.core.openMedia(ring, rec.bytes) }
}

/** The upload intents of one draft, or null (logged) when it must be skipped. */
async function packDraft(
  s: PushSession,
  p: Prepared,
  ring: KeyRing,
  draft: DraftRecord,
): Promise<SafeUploadIntent[] | null> {
  try {
    const entry = openEntry(s.deps.core, ring, draft)
    const sealedMediaMap = new Map<string, Uint8Array>()
    const plainMediaMap = new Map<string, Uint8Array>()
    const sealedThumbMap = new Map<string, Uint8Array>()
    const plainThumbMap = new Map<string, Uint8Array>()
    // Every ref must be present BEFORE packing: the packer silently drops incomplete media, and a
    // `.bin` must never land without the media it references.
    for (const ref of entry.media) {
      const id = ref.media_id
      const media = await openBlob(s, ring, `${OUTBOX_BLOB_PREFIX}m-${id}`)
      sealedMediaMap.set(id, media.sealed)
      plainMediaMap.set(id, media.plain)
      if (ref.has_thumb) {
        const thumb = await openBlob(s, ring, `${OUTBOX_BLOB_PREFIX}m-${id}.thumb`)
        sealedThumbMap.set(id, thumb.sealed)
        plainThumbMap.set(id, thumb.plain)
      }
    }
    return packOutboxUploadIntents({
      localGen: p.localGen,
      ownDeviceId: p.ownId,
      entry,
      sealedEntryBytes: draft.sealed,
      sealedMediaMap,
      plainMediaMap,
      sealedThumbMap,
      plainThumbMap,
    })
  } catch (error) {
    // Log the error name only: a JSON.parse message can quote decrypted text.
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping draft ${draft.entryId}: it cannot be pushed yet (${reason})`)
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// pushAll
// ---------------------------------------------------------------------------------------------

async function pending(s: PushSession): Promise<number> {
  return (await s.drafts.listUnpushedDrafts()).length
}

async function pushOnce(): Promise<PushResult> {
  const env = pushEnv()
  if (!env.isUnlocked()) return { pushed: 0, skipped: 0, pending: 0 }
  const started = epoch
  const assertSameEpoch = (): void => {
    if (started !== epoch) throw new VaultLockedError()
  }
  let pushed = 0
  let skipped = 0
  let s: PushSession | null = null
  try {
    s = await getSession()
    assertSameEpoch()
    if (!env.cachedWriteFlag()) return { pushed, skipped, pending: await pending(s) }
    const drafts = [...(await s.drafts.listUnpushedDrafts())].sort(
      (a, b) => a.updatedAt - b.updatedAt,
    )
    if (drafts.length === 0) return { pushed, skipped, pending: 0 }
    const p = await prepare(s)
    assertSameEpoch()
    if (!s.folderReady) {
      await safeEnsureOutboxFolder(uploadDeps(s, p, getKeyRing()))
      assertSameEpoch()
      s.folderReady = true
    }
    for (const draft of drafts) {
      assertSameEpoch()
      const ring = getKeyRing()
      const intents = await packDraft(s, p, ring, draft)
      if (intents === null) {
        skipped += 1
        continue
      }
      try {
        const outcome = await s.drafts.flush(
          draft.entryId,
          intents,
          uploadDeps(s, p, ring),
          draft.sealed,
        )
        if (outcome === 'pushed') {
          pushed += 1
        } else {
          console.warn(`Skipping draft ${draft.entryId}: it changed before its upload`)
          skipped += 1
        }
      } catch (error) {
        if (!(error instanceof SealVerifyError)) throw error
        console.warn(`Skipping draft ${draft.entryId}: seal-then-verify failed`)
        skipped += 1
      }
    }
    return { pushed, skipped, pending: await pending(s) }
  } catch (error) {
    const left = s === null ? 0 : await pending(s).catch(() => 0)
    return { pushed, skipped, pending: left, error }
  }
}

let running: Promise<PushResult> | null = null
let followUp: Promise<PushResult> | null = null

function launch(): Promise<PushResult> {
  const run = pushOnce().finally(() => {
    if (running === run) running = null
  })
  running = run
  return run
}

/**
 * Pushes every unpushed draft. Never rejects (see the header). A call during a run returns the
 * one shared follow-up run, which starts when the current run settles.
 */
export function pushAll(): Promise<PushResult> {
  if (running === null) return launch()
  followUp ??= running.then(() => {
    followUp = null
    return running ?? launch()
  })
  return followUp
}
