import { formatBytes } from './numbers'

/**
 * An i18n key (relative to the `settings` namespace) plus its interpolation
 * params. Returning the key instead of rendered text keeps this file free of
 * an i18n dependency, so it stays unit-testable without mocking `t`.
 */
export interface RecoveryBlockerMessage {
  key: string
  params?: Record<string, string>
}

export type RecoveryDirection = 'local_to_cloud' | 'cloud_to_local'

const PREFIX = 'gdrive.help.recovery.'

/**
 * Every key this module can return, under `gdrive.help.recovery.`. Typing the
 * suffixes as a union rather than `string` turns a typo at any of the ~20
 * return sites into a compile error instead of a missing key discovered at
 * runtime; the accompanying test asserts each one exists in both locales.
 */
const SUFFIXES = [
  'blocked_sync_in_progress',
  'blocked_not_connected',
  'blocked_force_re_pair',
  'blocked_rotation_active',
  'blocked_competing_recovery',
  'blocked_cloud_outdated',
  'blocked_cloud_outdated_use_local',
  'blocked_cloud_inconsistent',
  'blocked_other_job_active',
  'blocked_insufficient_disk',
  'blocked_media_incomplete',
  'blocked_cloud_unreadable',
  'blocked_backup_failed',
  'blocked_unknown',
  'failed_lease_lost',
  'failed_cloud_media_incomplete',
  'failed_upload_incomplete',
  'failed_fence_release',
  'failed_local_media_unreadable',
  'failed_key_unavailable',
  'failed_recovery_superseded',
  'failed_lease_unconfirmed',
  'error',
] as const

export type RecoveryMessageSuffix = (typeof SUFFIXES)[number]

/** Exposed so a test can assert every suffix has copy in every locale. */
export const RECOVERY_MESSAGE_SUFFIXES: readonly RecoveryMessageSuffix[] = SUFFIXES

/**
 * Key `recoveryFailureMessage` returns when nothing matched. Callers compare
 * against it to tell a self-contained sentence from a bare raw string — the
 * confirm-modal banner names the operation only in the latter case, where the
 * user would otherwise have no context at all.
 */
export const RECOVERY_FAILURE_FALLBACK_KEY = `${PREFIX}error`

/** Narrow a `SyncRecoveryStatus.operation` string to a known direction. */
export function toRecoveryDirection(
  operation: string | null | undefined,
): RecoveryDirection | null {
  return operation === 'local_to_cloud' || operation === 'cloud_to_local' ? operation : null
}

interface Match {
  suffix: RecoveryMessageSuffix
  params?: Record<string, string>
}

/**
 * Recognise a raw recovery error. Returns `null` when nothing matches, so each
 * caller can supply the fallback that fits its phase.
 *
 * Order is load-bearing — several specific strings are substrings of a more
 * general branch below them (see the inline notes).
 */
function classify(lower: string, direction: RecoveryDirection | null): Match | null {
  if (lower === 'sync_in_progress') return { suffix: 'blocked_sync_in_progress' }
  if (lower.includes('not connected to google drive')) return { suffix: 'blocked_not_connected' }
  if (lower.includes('force re-pair')) return { suffix: 'blocked_force_re_pair' }
  if (lower.includes('key rotation')) return { suffix: 'blocked_rotation_active' }

  // Lease handling is enumerated, never a catch-all on "recovery lease" — the
  // phrase appears in both halves of an opposite pair. THIS job's claim is
  // gone or was never valid; waiting for a rival cannot help.
  if (
    lower.includes('recovery lease missing') ||
    lower.includes('recovery marker missing') ||
    lower.includes('recovery lease does not match') ||
    lower.includes('owned by another job') ||
    lower.includes('cloud cleanup requires an active recovery lease')
  ) {
    return { suffix: 'failed_lease_lost' }
  }
  // Both wordings of the "superseded" proof — the cloud holds no lease for us
  // and its generation moved past ours. The permit-resume path raises the
  // first, the narrow release-race the second. Note `does not match job` does
  // NOT match `recovery lease does not match the active job` (handled above)
  // nor `control recovery_generation X != job Y`, which means something else.
  if (lower.includes('does not match job') || lower.includes('does not match the permit')) {
    return { suffix: 'failed_recovery_superseded' }
  }
  // Every `readback` failure means the lease/marker state could not be
  // confirmed either way. Must precede the fence-release branch below: the
  // wrapped shape of the release readback starts with `fence release failed:`,
  // which would otherwise hand an inconclusive state a confident diagnosis.
  if (lower.includes('readback')) return { suffix: 'failed_lease_unconfirmed' }
  // A rival genuinely holds the cloud. `competing` is what the backend's own
  // `classify_recovery_error` keys on, and the sentence it appears in says
  // "cloud lease", so matching "recovery lease" alone would miss it.
  if (
    lower.includes('competing') ||
    lower.includes('cloud is under recovery lease') ||
    lower.includes('recovery lease was won by another')
  ) {
    return { suffix: 'blocked_competing_recovery' }
  }

  if (lower.includes('recovery_generation_rollback')) {
    // The advice only holds for a cloud→local restore; `local_to_cloud` is
    // itself the remedy, so never tell that direction to run itself.
    return {
      suffix:
        direction === 'cloud_to_local'
          ? 'blocked_cloud_outdated_use_local'
          : 'blocked_cloud_outdated',
    }
  }
  if (lower.includes('recovery_generation_mismatch'))
    return { suffix: 'blocked_cloud_inconsistent' }
  if (lower.includes('a different recovery job is already active')) {
    return { suffix: 'blocked_other_job_active' }
  }

  // Two call sites, two wordings: the preflight gate and the mid-download
  // probe (`… during media download: … bytes free, have …`).
  const disk = /insufficient free disk[^:]*: need at least (\d+) bytes(?: free)?, have (\d+)/.exec(
    lower,
  )
  if (disk) {
    return {
      suffix: 'blocked_insufficient_disk',
      params: {
        needed: formatBytes(Number(disk[1])),
        available: formatBytes(Number(disk[2])),
      },
    }
  }

  // Local originals this device was supposed to own …
  const localMedia = /local vault is incomplete: (\d+) missing, (\d+) corrupt/.exec(lower)
  if (localMedia) {
    return {
      suffix: 'blocked_media_incomplete',
      params: { missing: localMedia[1], corrupt: localMedia[2] },
    }
  }
  // … versus originals that could not be pulled down from Drive.
  const cloudMedia = /cloud-authoritative media incomplete: (\d+) missing, (\d+) corrupt/.exec(
    lower,
  )
  if (cloudMedia) {
    return {
      suffix: 'failed_cloud_media_incomplete',
      params: { missing: cloudMedia[1], corrupt: cloudMedia[2] },
    }
  }

  if (lower.includes('channel upload completed with errors')) {
    return { suffix: 'failed_upload_incomplete' }
  }
  // `release_recovery_lease` reaches THIS surface through two callers: one
  // wraps its error as `fence release failed: …`, the other passes it bare. So
  // the same anomaly arrives in two shapes and both must land here. (A third
  // caller, `gdrive_wipe_cloud`, wraps the same errors but routes to the
  // delete-and-disconnect error line, never through this module — if that ever
  // changes, its "Cloud wiped but failed to release cleanup lease" wording
  // would land here and claim a transfer finished.)
  if (
    lower.includes('fence release failed') ||
    lower.includes('before lease release') ||
    lower.includes('before exact release') ||
    lower.includes('disappeared during release') ||
    lower.includes('still has a live marker')
  ) {
    return { suffix: 'failed_fence_release' }
  }

  // Local originals this device cannot read off its own disk. Must precede the
  // cloud branch below — otherwise a bare `unreadable` match would tell the
  // user to check their internet connection over a local-disk problem.
  if (lower.includes('media original unreadable')) {
    return { suffix: 'failed_local_media_unreadable' }
  }
  // Enumerated rather than a bare `unreadable` match, for the same reason.
  if (
    lower.includes('cloud control unreadable') ||
    lower.includes('keyring meta unreadable') ||
    lower.includes('keyring content unreadable') ||
    lower.includes('control.json unreadable')
  ) {
    return { suffix: 'blocked_cloud_unreadable' }
  }

  if (lower.includes('recovery backup failed')) return { suffix: 'blocked_backup_failed' }
  // Covers `db_key unavailable for {backup,staging,materialize,commit}` and
  // the `sync key` / `content/sync key` siblings alike: every one of them can
  // only come from the same locked-key-state guard, so the remedy is shared.
  if (lower.includes('key unavailable')) return { suffix: 'failed_key_unavailable' }

  return null
}

function build(
  match: Match | null,
  fallback: RecoveryMessageSuffix,
  raw: string,
): RecoveryBlockerMessage {
  if (!match) return { key: `${PREFIX}${fallback}`, params: { message: raw } }
  return { key: `${PREFIX}${match.suffix}`, params: match.params }
}

/**
 * Map a raw preflight/staging rejection into readable copy.
 *
 * `gdrive_preflight_local_authoritative_recovery` and
 * `gdrive_begin_cloud_authoritative_staging` both return `Result<_, String>`,
 * so the blocker reaches the UI as an engineer-facing sentence (or a bare code
 * like `sync_in_progress`). The error `kind` never crosses the IPC boundary,
 * and several blockers are produced by the command wrapper itself — outside
 * the error enums entirely — so substring matching is the only handle we have.
 * This mirrors `classify_recovery_error` in `src-tauri/src/commands/gdrive.rs`,
 * which classifies the same strings the same way.
 *
 * Anything unrecognised falls through to `blocked_unknown`, which still shows
 * the raw text so an unmapped blocker stays diagnosable.
 */
export function recoveryBlockerMessage(
  raw: string,
  direction: RecoveryDirection | null = null,
): RecoveryBlockerMessage {
  const text = raw.trim()
  return build(classify(text.toLowerCase(), direction), 'blocked_unknown', text)
}

/**
 * Same mapping for a recovery that already started and then failed — the
 * banner surface fed by `gdrive_resume_sync_recovery` and by the job row's
 * `lastError`.
 *
 * The step commands behind resume (rebuild, materialize, finalize, commit)
 * raise far more internal failures than preflight does, and most carry no
 * advice a user could act on. Those fall back to `recovery.error`, the bare
 * `{{message}}` passthrough — every surface that renders a failure already
 * frames it (a "Recovery interrupted" heading, or "Could not replace this
 * device: …"), so a second prefix here would read as a sentence inside a
 * sentence. Unmapped failures therefore look exactly as they do today.
 */
export function recoveryFailureMessage(
  raw: string,
  direction: RecoveryDirection | null = null,
): RecoveryBlockerMessage {
  const text = raw.trim()
  return build(classify(text.toLowerCase(), direction), 'error', text)
}
