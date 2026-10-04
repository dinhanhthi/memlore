/**
 * Recovery fence (control + keyring meta) - Phase 15.1.
 *
 * Re-reads `control.json` AND `_meta.json` immediately before every write batch and calls
 * `authorizePush` (WASM copy, which has parity with desktop).
 *
 * Refuses when:
 *  - a lease is present;
 *  - the generation is ahead of or behind the local record;
 *  - `master_fingerprint`, `epoch` or `content_epoch` changed since the last pull;
 *  - the control file is missing.
 *
 * On refusal it pauses writes, keeps drafts, and triggers a re-validation pull.
 * The web NEVER writes `control.json`, the marker or `_meta.json`.
 */

import type { Core } from '../../core/core'
import {
  DriveNotFoundError,
  VaultNotReadyError,
  type DriveReader,
} from '../drive/client'
import {
  isValidGeneration,
} from '../drive/paths'
import { ERROR_NAMES } from '../errorNames'
import { checkControlFile, checkKeyringMeta } from './formatGuard'
import {
  CONTROL_PATH,
  META_PATH,
  VaultCorruptError,
  type ControlState,
  type MetaState,
} from './onboard'

export type RecoveryFenceReason =
  | 'missing-control'
  | 'missing-meta'
  | 'lease-active'
  | 'generation-mismatch'
  | 'fingerprint-mismatch'
  | 'epoch-mismatch'
  | 'content-epoch-mismatch'
  | 'authorize-push-refused'

export class RecoveryFenceError extends Error {
  readonly reason: RecoveryFenceReason

  constructor(message: string, reason: RecoveryFenceReason, cause?: unknown) {
    super(message, { cause })
    this.name = ERROR_NAMES.recoveryFence
    this.reason = reason
  }
}

export interface ExpectedVaultState {
  recoveryGeneration: number
  masterFingerprint: string
  epoch: number
  contentEpoch: number
}

export interface FenceDeps {
  reader: DriveReader
  core: Core
  expected: ExpectedVaultState
  revalidatePull?: () => Promise<void> | void
}

let writesPaused = false
let pauseReason: string | null = null
type RevalidationPullHandler = () => Promise<void> | void
let revalidationHandler: RevalidationPullHandler | null = null

export function isWritesPaused(): boolean {
  return writesPaused
}

export function getWritePauseReason(): string | null {
  return pauseReason
}

export function pauseWrites(reason: string): void {
  writesPaused = true
  pauseReason = reason
}

export function resumeWrites(): void {
  writesPaused = false
  pauseReason = null
}

export function setRevalidationPullHandler(handler: RevalidationPullHandler | null): void {
  revalidationHandler = handler
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseControlState(core: Core, text: string): ControlState {
  let canonical: string
  try {
    canonical = core.parseSyncControl(text)
  } catch (error) {
    throw new VaultCorruptError(`${CONTROL_PATH}: ${errorMessage(error)}`)
  }
  const parsed = JSON.parse(canonical) as Record<string, unknown>
  const generation = parsed.recovery_generation
  if (typeof generation !== 'number' || !isValidGeneration(generation)) {
    throw new VaultCorruptError(`${CONTROL_PATH}: bad recovery_generation`)
  }
  return {
    recoveryGeneration: generation,
    leaseActive: parsed.recovery_lease !== null && parsed.recovery_lease !== undefined,
    canonical,
  }
}

function parseMetaState(core: Core, text: string): MetaState {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(core.parseKeyringMeta(text)) as Record<string, unknown>
  } catch (error) {
    throw new VaultCorruptError(`${META_PATH}: ${errorMessage(error)}`)
  }
  const { master_fingerprint: fp, epoch, content_epoch: contentEpoch } = parsed
  const generation = parsed.recovery_generation
  if (
    typeof fp !== 'string' ||
    typeof epoch !== 'number' ||
    typeof contentEpoch !== 'number' ||
    typeof generation !== 'number'
  ) {
    throw new VaultCorruptError(`${META_PATH}: unexpected shape`)
  }
  return { masterFingerprint: fp, epoch, contentEpoch, recoveryGeneration: generation }
}

/**
 * Re-reads `control.json` and `_meta.json` and validates the recovery fence.
 * Throws `RecoveryFenceError` on refusal, which pauses writes and schedules a re-validation pull.
 */
export async function assertRecoveryFence(deps: FenceDeps): Promise<{
  control: ControlState
  meta: MetaState
}> {
  let control: ControlState
  try {
    const raw = await deps.reader.readSharedFile(CONTROL_PATH)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    checkControlFile(deps.core, CONTROL_PATH, text)
    control = parseControlState(deps.core, text)
  } catch (error) {
    if (error instanceof DriveNotFoundError) {
      return handleRefusal(
        new RecoveryFenceError(
          'Control file is missing from cloud vault',
          'missing-control',
          error,
        ),
        deps,
      )
    }
    if (error instanceof VaultNotReadyError || error instanceof VaultCorruptError) {
      return handleRefusal(
        new RecoveryFenceError(
          errorMessage(error),
          'missing-control',
          error,
        ),
        deps,
      )
    }
    throw error
  }

  let meta: MetaState
  try {
    const raw = await deps.reader.readSharedFile(META_PATH)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    checkKeyringMeta(deps.core, META_PATH, text)
    meta = parseMetaState(deps.core, text)
  } catch (error) {
    if (error instanceof DriveNotFoundError) {
      return handleRefusal(
        new RecoveryFenceError(
          'Cloud vault _meta.json is missing',
          'missing-meta',
          error,
        ),
        deps,
      )
    }
    if (error instanceof VaultNotReadyError || error instanceof VaultCorruptError) {
      return handleRefusal(
        new RecoveryFenceError(
          errorMessage(error),
          'missing-meta',
          error,
        ),
        deps,
      )
    }
    throw error
  }

  // 1. Lease check
  if (control.leaseActive) {
    return handleRefusal(
      new RecoveryFenceError(
        'An authoritative recovery lease is active on the cloud vault',
        'lease-active',
      ),
      deps,
    )
  }

  // 2. Generation & authorizePush check
  if (control.recoveryGeneration !== deps.expected.recoveryGeneration) {
    try {
      deps.core.authorizePush(
        JSON.stringify({
          marker: null,
          cloud_generation: control.recoveryGeneration,
          local_generation: deps.expected.recoveryGeneration,
          permit: null,
        }),
      )
    } catch (pushErr) {
      return handleRefusal(
        new RecoveryFenceError(errorMessage(pushErr), 'generation-mismatch', pushErr),
        deps,
      )
    }
    return handleRefusal(
      new RecoveryFenceError(
        `Recovery generation mismatch: cloud=${control.recoveryGeneration}, local=${deps.expected.recoveryGeneration}`,
        'generation-mismatch',
      ),
      deps,
    )
  }

  try {
    deps.core.authorizePush(
      JSON.stringify({
        marker: null,
        cloud_generation: control.recoveryGeneration,
        local_generation: deps.expected.recoveryGeneration,
        permit: null,
      }),
    )
  } catch (pushErr) {
    return handleRefusal(
      new RecoveryFenceError(errorMessage(pushErr), 'authorize-push-refused', pushErr),
      deps,
    )
  }

  // 3. Fingerprint check
  if (meta.masterFingerprint !== deps.expected.masterFingerprint) {
    return handleRefusal(
      new RecoveryFenceError(
        `Master key fingerprint changed: cloud=${meta.masterFingerprint}, expected=${deps.expected.masterFingerprint}`,
        'fingerprint-mismatch',
      ),
      deps,
    )
  }

  // 4. Epoch check
  if (meta.epoch !== deps.expected.epoch) {
    return handleRefusal(
      new RecoveryFenceError(
        `Keyring epoch changed: cloud=${meta.epoch}, expected=${deps.expected.epoch}`,
        'epoch-mismatch',
      ),
      deps,
    )
  }

  // 5. Content epoch check
  if (meta.contentEpoch !== deps.expected.contentEpoch) {
    return handleRefusal(
      new RecoveryFenceError(
        `Content epoch changed: cloud=${meta.contentEpoch}, expected=${deps.expected.contentEpoch}`,
        'content-epoch-mismatch',
      ),
      deps,
    )
  }

  // All fence checks passed: self-heal by clearing any past pause
  resumeWrites()
  return { control, meta }
}

function handleRefusal(err: RecoveryFenceError, deps: FenceDeps): never {
  pauseWrites(err.message)
  const pull = deps.revalidatePull ?? revalidationHandler
  if (pull) {
    try {
      void Promise.resolve(pull()).catch(() => {
        // Revalidation pull triggered best-effort
      })
    } catch {
      // Revalidation pull triggered best-effort
    }
  }
  throw err
}
