/**
 * safeUpload: the only write path (Phase 15.4).
 *
 * `safeUpload.ts` is the ONLY importer of `DriveWriter`, other than `onboard.ts`. The push session
 * (`push.ts`) gets its writer from `createOutboxWriter` and creates the outbox folder only through
 * `safeEnsureOutboxFolder`, which runs checks 1-4 below first.
 * Each batch runs inside the `navigator.locks` single-writer lock, and checks in order:
 *  1. a FRESH `fetchWriteFlag()` (fail-closed);
 *  2. `assertClockOk()`;
 *  3. the fence (`assertRecoveryFence`);
 *  4. the format guard (`assertFormatGuardOk`);
 *  5. every target path matches the outbox allowlist (`generations/g-<localGen>/<webId>/outbox/…`);
 *  6. seal-then-verify: re-open the sealed bytes with WASM (`openOutboxEntry` / `openMedia`, and
 *     `openOutboxIntent` for a v2 intent) and require an exact match with the intended content. A
 *     v2 intent must also sit under the name of its kind and id (`j-|t-|p-|d-<id>.bin`), which the
 *     desktop importer checks too (a mismatch there is a final `corrupt`). A failure is a `SealVerifyError`, so a
 *     caller can skip that one batch; every other refusal concerns the whole vault;
 *  7. the caller's optional `beforeWrite` freshness check (still under the lock): `false` is a
 *     `StaleWriteError`, so the caller can skip that one batch, nothing written.
 *
 * Only then does it write each intent through the lock-scoped `put` handed to the batch by
 * `DriveWriter.withLock` (update-in-place).
 */

import { openOutboxIntent, type Core, type OutboxIntentV2 } from '../../core/core'
import type { KeyRing } from '../keys'
import { assertClockOk } from '../clock'
import { fetchWriteFlag } from '../config'
import {
  DriveWriter,
  type DriveReader,
  type DriveWriterDeps,
  type EnsureFolderResult,
  type LockManagerLike,
  type PutResult,
  type WriterIdentity,
} from '../drive/client'
import {
  isValidGeneration,
  isValidOwnId,
  outboxIntentPath,
  type OutboxIntentPrefix,
} from '../drive/paths'
import { sameBytes } from '../storage/idb'
import { assertRecoveryFence, type ExpectedVaultState } from './fence'
import { assertFormatGuardOk } from './formatGuard'

/** Seal-then-verify (check 6) refused this batch: its bytes do not round-trip. */
export class SealVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealVerifyError'
  }
}

/** The caller's `beforeWrite` (check 7) refused this batch: its source changed. Nothing written. */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleWriteError'
  }
}

export interface SafeUploadIntent {
  path: string
  bytes: Uint8Array
  intended:
    | { kind: 'entry'; entry: unknown }
    | { kind: 'media'; plaintext: Uint8Array }
    | { kind: 'thumb'; plaintext: Uint8Array }
    | { kind: 'intent_v2'; intent: OutboxIntentV2 }
}

/**
 * File-name prefix and id of a v2 intent: memlore-core `OutboxIntentV2::prefix` / `target_id`
 * (`outbox.rs`). Both template kinds share `p-<templateId>`; a trash is `d-<entryId>`.
 */
export function v2IntentTarget(intent: OutboxIntentV2): { prefix: OutboxIntentPrefix; id: string } {
  switch (intent.kind) {
    case 'create_journal':
      return { prefix: 'j', id: intent.journal_id }
    case 'create_tag':
      return { prefix: 't', id: intent.tag_id }
    case 'upsert_template':
    case 'delete_template':
      return { prefix: 'p', id: intent.template_id }
    case 'trash_entry':
      return { prefix: 'd', id: intent.entry_id }
  }
}

/** Opens sealed v2 intent bytes (frame 2 only; a v1 entry frame throws). */
export function openV2Intent(
  core: Pick<Core, 'openOutboxIntent'>,
  ring: KeyRing,
  bytes: Uint8Array,
): OutboxIntentV2 {
  const opened = openOutboxIntent(core, ring, bytes)
  if (opened.version !== 2) throw new SealVerifyError('not a v2 intent (frame 1)')
  return opened.intent
}

export interface SafeUploadDeps {
  writer: DriveWriter
  reader: DriveReader
  core: Core
  ring: KeyRing
  localGen: number
  ownDeviceId: string
  expectedFence: ExpectedVaultState
  fetchWriteFlagImpl?: () => Promise<boolean>
  locks?: LockManagerLike | null
  revalidatePull?: () => Promise<void> | void
  /**
   * Check 7, run under the lock after checks 1-6 and before the first write: is the source of
   * these intents still current? `false` aborts with `StaleWriteError`.
   */
  beforeWrite?: () => Promise<boolean>
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.hasOwn(bRecord, k) || !deepEqual(aRecord[k], bRecord[k])) {
      return false
    }
  }
  return true
}

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/**
 * Check 5's allowlist: `<uuid>.bin` (entry), `[jtpd]-<uuid>.bin` (v2 intent), `m-<uuid>` and
 * `m-<uuid>.thumb` in the flat own outbox of `localGen`. Keep in sync with `isAllowedWritePath` in
 * `drive/paths.ts` (the writer's own check).
 */
export function isOutboxIntentPath(path: string, localGen: number, ownId: string): boolean {
  if (!isValidGeneration(localGen) || !isValidOwnId(ownId)) return false
  const outboxPattern = new RegExp(
    `^generations/g-${localGen}/${ownId}/outbox/(?:(?:[jtpd]-)?${UUID_PATTERN}\\.bin|m-${UUID_PATTERN}(?:\\.thumb)?)$`,
  )
  return outboxPattern.test(path)
}

/** Check 6 for a v2 intent: the bytes open to exactly `expected`, under its own file name. */
function verifyV2(
  path: string,
  bytes: Uint8Array,
  expected: OutboxIntentV2,
  deps: SafeUploadDeps,
): void {
  let opened: OutboxIntentV2
  try {
    opened = openV2Intent(deps.core, deps.ring, bytes)
  } catch (err: unknown) {
    throw new SealVerifyError(
      `Seal-then-verify failed to open v2 intent at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!deepEqual(opened, expected)) {
    throw new SealVerifyError(`Seal-then-verify payload mismatch for v2 intent at ${path}`)
  }
  const { prefix, id } = v2IntentTarget(opened)
  let named: string
  try {
    named = outboxIntentPath(deps.ownDeviceId, deps.localGen, prefix, id)
  } catch {
    throw new SealVerifyError(`Seal-then-verify: v2 intent id is not a uuid at ${path}`)
  }
  if (path !== named) {
    throw new SealVerifyError(`Seal-then-verify: v2 intent name does not match its body at ${path}`)
  }
}

/** A writer for the outbox of `identity` (the push session's only way to get one). */
export function createOutboxWriter(
  reader: DriveReader,
  deps: DriveWriterDeps,
  identity: WriterIdentity,
): DriveWriter {
  const writer = new DriveWriter(reader, deps)
  writer.setIdentity(identity)
  return writer
}

/** Checks 1-4: write flag, clock, fence, format guard. The caller holds the writer lock. */
async function assertBatchAllowed(deps: SafeUploadDeps): Promise<void> {
  // 1. Fresh fetchWriteFlag (fail-closed)
  const fetchFlag = deps.fetchWriteFlagImpl ?? fetchWriteFlag
  const writeAllowed = await fetchFlag()
  if (!writeAllowed) {
    throw new Error('Writes disabled: write flag is false')
  }

  // 2. assertClockOk
  assertClockOk()

  // 3. The recovery fence (also contacts server and updates clock offset)
  await assertRecoveryFence({
    reader: deps.reader,
    core: deps.core,
    expected: deps.expectedFence,
    revalidatePull: deps.revalidatePull,
  })

  // Re-assert clock now that server Date header was sampled during fence read
  assertClockOk()

  // 4. The format guard
  assertFormatGuardOk()
}

/**
 * Creates `<ownId>` and `<ownId>/outbox` (the only folders the web may create) under the writer
 * lock, after the same checks 1-4 as an upload batch: a folder is a write too.
 */
export async function safeEnsureOutboxFolder(deps: SafeUploadDeps): Promise<EnsureFolderResult> {
  return deps.writer.withLock(async (locked) => {
    await assertBatchAllowed(deps)
    return locked.ensureFolder()
  }, deps.locks)
}

export async function safeUpload(
  intents: readonly SafeUploadIntent[],
  deps: SafeUploadDeps,
): Promise<PutResult[]> {
  return deps.writer.withLock(async (locked) => {
    // 1-4. Write flag, clock, fence, format guard
    await assertBatchAllowed(deps)

    // 5. Every target path matches the outbox allowlist
    for (const intent of intents) {
      if (!isOutboxIntentPath(intent.path, deps.localGen, deps.ownDeviceId)) {
        throw new Error(
          `Target path does not match outbox allowlist: ${intent.path} (localGen=${deps.localGen}, ownDeviceId=${deps.ownDeviceId})`,
        )
      }
    }

    // 6. Seal-then-verify: re-open sealed bytes and require exact match
    for (const intent of intents) {
      if (intent.intended.kind === 'entry') {
        let openedJson: string
        try {
          openedJson = deps.core.openOutboxEntry(deps.ring, intent.bytes)
        } catch (err: unknown) {
          throw new SealVerifyError(
            `Seal-then-verify failed to open entry at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const opened = JSON.parse(openedJson)
        const expected =
          typeof intent.intended.entry === 'string'
            ? JSON.parse(intent.intended.entry)
            : intent.intended.entry
        if (!deepEqual(opened, expected)) {
          throw new SealVerifyError(`Seal-then-verify payload mismatch for entry at ${intent.path}`)
        }
      } else if (intent.intended.kind === 'intent_v2') {
        verifyV2(intent.path, intent.bytes, intent.intended.intent, deps)
      } else {
        let openedBytes: Uint8Array
        try {
          openedBytes = deps.core.openMedia(deps.ring, intent.bytes)
        } catch (err: unknown) {
          throw new SealVerifyError(
            `Seal-then-verify failed to open media at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const expected = intent.intended.plaintext
        if (!sameBytes(openedBytes, expected)) {
          throw new SealVerifyError(
            `Seal-then-verify plaintext mismatch for media at ${intent.path}`,
          )
        }
      }
    }

    // 7. The caller's freshness check, under the same lock as the writes
    if (deps.beforeWrite !== undefined && !(await deps.beforeWrite())) {
      throw new StaleWriteError('The source of this batch changed before it was written')
    }

    // All 7 checks passed: perform mutating writes in place through the lock-scoped handle (it
    // does not re-acquire the lock this batch holds, and re-runs the writer's own path checks).
    const results: PutResult[] = []
    for (const intent of intents) {
      const result = await locked.put(intent.path, intent.bytes)
      results.push(result)
    }
    return results
  }, deps.locks)
}
