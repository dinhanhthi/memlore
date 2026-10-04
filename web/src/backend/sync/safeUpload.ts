/**
 * safeUpload: the only write path (Phase 15.4).
 *
 * `safeUpload.ts` is the ONLY importer of `DriveWriter`, other than `onboard.ts`.
 * Each batch runs inside the `navigator.locks` single-writer lock, and checks in order:
 *  1. a FRESH `fetchWriteFlag()` (fail-closed);
 *  2. `assertClockOk()`;
 *  3. the fence (`assertRecoveryFence`);
 *  4. the format guard (`assertFormatGuardOk`);
 *  5. every target path matches the outbox allowlist (`generations/g-<localGen>/<webId>/outbox/…`);
 *  6. seal-then-verify: re-open the sealed bytes with WASM (`openOutboxEntry` / `openMedia`) and
 *     require an exact match with the intended content.
 *
 * Only then does it call `DriveWriter.put` (update-in-place).
 */

import type { Core } from '../../core/core'
import type { KeyRing } from '../keys'
import { assertClockOk } from '../clock'
import { fetchWriteFlag } from '../config'
import {
  DriveWriter,
  type DriveReader,
  type LockManagerLike,
  type PutResult,
} from '../drive/client'
import {
  isValidGeneration,
  isValidOwnId,
} from '../drive/paths'
import {
  assertRecoveryFence,
  type ExpectedVaultState,
} from './fence'
import { assertFormatGuardOk } from './formatGuard'

export interface SafeUploadIntent {
  path: string
  bytes: Uint8Array
  intended:
    | { kind: 'entry'; entry: unknown }
    | { kind: 'media'; plaintext: Uint8Array }
    | { kind: 'thumb'; plaintext: Uint8Array }
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
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
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

export function isOutboxIntentPath(path: string, localGen: number, ownId: string): boolean {
  if (!isValidGeneration(localGen) || !isValidOwnId(ownId)) return false
  const outboxPattern = new RegExp(
    `^generations/g-${localGen}/${ownId}/outbox/(?:${UUID_PATTERN}\\.bin|m-${UUID_PATTERN}(?:\\.thumb)?)$`,
  )
  return outboxPattern.test(path)
}

export async function safeUpload(
  intents: readonly SafeUploadIntent[],
  deps: SafeUploadDeps,
): Promise<PutResult[]> {
  return deps.writer.withLock(async () => {
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
          throw new Error(
            `Seal-then-verify failed to open entry at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const opened = JSON.parse(openedJson)
        const expected =
          typeof intent.intended.entry === 'string'
            ? JSON.parse(intent.intended.entry)
            : intent.intended.entry
        if (!deepEqual(opened, expected)) {
          throw new Error(`Seal-then-verify payload mismatch for entry at ${intent.path}`)
        }
      } else {
        let openedBytes: Uint8Array
        try {
          openedBytes = deps.core.openMedia(deps.ring, intent.bytes)
        } catch (err: unknown) {
          throw new Error(
            `Seal-then-verify failed to open media at ${intent.path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const expected = intent.intended.plaintext
        if (!bytesEqual(openedBytes, expected)) {
          throw new Error(`Seal-then-verify plaintext mismatch for media at ${intent.path}`)
        }
      }
    }

    // All 6 checks passed: perform mutating writes in place via writer.put
    const results: PutResult[] = []
    for (const intent of intents) {
      const result = await deps.writer.put(intent.path, intent.bytes)
      results.push(result)
    }
    return results
  }, deps.locks)
}
