import { describe, expect, it } from 'vitest'
import en from '../locales/en/settings.json'
import vi from '../locales/vi/settings.json'
import {
  RECOVERY_FAILURE_FALLBACK_KEY,
  RECOVERY_MESSAGE_SUFFIXES,
  recoveryBlockerMessage,
  recoveryFailureMessage,
  toRecoveryDirection,
} from './recoveryBlockerMessage'

const K = 'gdrive.help.recovery.'

describe('recoveryBlockerMessage', () => {
  it('maps the bare sync_in_progress code', () => {
    expect(recoveryBlockerMessage('sync_in_progress')).toEqual({
      key: `${K}blocked_sync_in_progress`,
    })
  })

  it('maps the command-wrapper "not connected" blocker', () => {
    expect(recoveryBlockerMessage('Not connected to Google Drive')).toEqual({
      key: `${K}blocked_not_connected`,
    })
  })

  it('maps force re-pair for both recovery directions', () => {
    expect(
      recoveryBlockerMessage(
        'force re-pair is required; finish re-pair before cloud-authoritative restore',
      ),
    ).toEqual({ key: `${K}blocked_force_re_pair` })
    expect(
      recoveryBlockerMessage(
        'force re-pair is required; finish re-pair before local-authoritative recovery',
      ),
    ).toEqual({ key: `${K}blocked_force_re_pair` })
  })

  it('maps an active key rotation', () => {
    expect(
      recoveryBlockerMessage('an active key rotation blocks cloud-authoritative restore'),
    ).toEqual({ key: `${K}blocked_rotation_active` })
  })

  it('maps a competing recovery lease', () => {
    expect(recoveryBlockerMessage('cloud is under recovery lease job=7 op=local_to_cloud')).toEqual(
      {
        key: `${K}blocked_competing_recovery`,
      },
    )
  })

  // The "use Replace Google Drive with this device instead" advice is only
  // right for a cloud→local restore — local→cloud IS that remedy.
  it('only gives the use-local advice in the cloud-to-local direction', () => {
    const raw = 'RECOVERY_GENERATION_ROLLBACK: cloud=2, local=5'
    expect(recoveryBlockerMessage(raw, 'cloud_to_local')).toEqual({
      key: `${K}blocked_cloud_outdated_use_local`,
    })
    expect(recoveryBlockerMessage(raw, 'local_to_cloud')).toEqual({
      key: `${K}blocked_cloud_outdated`,
    })
    expect(recoveryBlockerMessage(raw)).toEqual({ key: `${K}blocked_cloud_outdated` })
  })

  it('separates a generation rollback from a generation mismatch', () => {
    expect(recoveryBlockerMessage('RECOVERY_GENERATION_ROLLBACK: cloud=2, local=5')).toEqual({
      key: `${K}blocked_cloud_outdated`,
    })
    expect(
      recoveryBlockerMessage('RECOVERY_GENERATION_MISMATCH: control=5, keyring_meta=4'),
    ).toEqual({ key: `${K}blocked_cloud_inconsistent` })
  })

  it('maps another active recovery job on this device', () => {
    expect(recoveryBlockerMessage('a different recovery job is already active')).toEqual({
      key: `${K}blocked_other_job_active`,
    })
  })

  it('formats the disk shortfall as human-readable sizes', () => {
    expect(
      recoveryBlockerMessage('insufficient free disk: need at least 2097152 bytes, have 1048576'),
    ).toEqual({
      key: `${K}blocked_insufficient_disk`,
      params: { needed: '2.0 MB', available: '1.0 MB' },
    })
  })

  // `formatBytes(0)` is special-cased and skips the `Math.log` path the other
  // sizes take, so the genuinely-full disk needs its own case.
  it('formats a zero-bytes-free disk rather than falling through', () => {
    expect(
      recoveryBlockerMessage('insufficient free disk: need at least 1024 bytes, have 0'),
    ).toEqual({
      key: `${K}blocked_insufficient_disk`,
      params: { needed: '1.0 KB', available: '0 B' },
    })
  })

  it('keeps the missing/corrupt media counts', () => {
    expect(
      recoveryBlockerMessage('local vault is incomplete: 3 missing, 1 corrupt media originals'),
    ).toEqual({
      key: `${K}blocked_media_incomplete`,
      params: { missing: '3', corrupt: '1' },
    })
  })

  it('maps every unreadable cloud/keyring probe to one message', () => {
    expect(recoveryBlockerMessage('cloud control unreadable: Io(timeout)')).toEqual({
      key: `${K}blocked_cloud_unreadable`,
    })
    expect(recoveryBlockerMessage('keyring meta unreadable: NotFound("_meta.json")')).toEqual({
      key: `${K}blocked_cloud_unreadable`,
    })
    expect(recoveryBlockerMessage('keyring content unreadable: Io(parse)')).toEqual({
      key: `${K}blocked_cloud_unreadable`,
    })
  })

  it('maps a failed local recovery backup', () => {
    expect(recoveryBlockerMessage('recovery backup failed: disk full')).toEqual({
      key: `${K}blocked_backup_failed`,
    })
  })

  it('falls back to the raw text so unmapped blockers stay diagnosable', () => {
    expect(recoveryBlockerMessage('  create staging media dir: EACCES  ')).toEqual({
      key: `${K}blocked_unknown`,
      params: { message: 'create staging media dir: EACCES' },
    })
  })

  // These come from the Tauri command wrappers, not the error enums, and are
  // deliberately left raw — rare OS/IO failures with no useful advice to give.
  // Pinned so a future branch cannot swallow them by accident.
  it.each([
    'Failed to resolve app data dir: no home directory',
    'Failed to create recovery work dir: Permission denied (os error 13)',
  ])('leaves the command-wrapper failure %s raw', (raw) => {
    expect(recoveryBlockerMessage(raw)).toEqual({
      key: `${K}blocked_unknown`,
      params: { message: raw },
    })
  })
})

describe('recoveryFailureMessage', () => {
  it('shares the mapping table with the preflight blockers', () => {
    expect(recoveryFailureMessage('sync_in_progress')).toEqual({
      key: `${K}blocked_sync_in_progress`,
    })
  })

  // Every failure surface already frames the message, so an unmapped error
  // stays a bare passthrough rather than gaining a second prefix.
  it('falls back to the bare passthrough, not the preflight wording', () => {
    expect(recoveryFailureMessage('channel order mismatch: expected 3, got 2')).toEqual({
      key: `${K}error`,
      params: { message: 'channel order mismatch: expected 3, got 2' },
    })
  })

  // "recovery lease" appears in both halves of an opposite pair, so each side
  // is enumerated. These mean THIS job lost its claim — waiting cannot help.
  it.each([
    'recovery lease missing while verifying post-upload cloud',
    'recovery marker missing while verifying post-upload cloud',
    'recovery lease does not match the active job',
    'cloud cleanup requires an active recovery lease',
  ])('reads %s as a lost claim, not a competing recovery', (raw) => {
    expect(recoveryFailureMessage(raw)).toEqual({ key: `${K}failed_lease_lost` })
  })

  // The backend's own classifier keys on "competing", but that sentence says
  // "cloud lease" — matching "recovery lease" alone would miss it entirely.
  it.each([
    'cloud is under recovery lease job=7 op=local_to_cloud',
    'a competing authoritative recovery already owns the cloud lease',
    'recovery lease was won by another provider',
  ])('reads %s as a rival holding the cloud', (raw) => {
    expect(recoveryFailureMessage(raw)).toEqual({ key: `${K}blocked_competing_recovery` })
  })

  // Separate wording: cloud originals that would not download, versus local
  // originals this device was supposed to own.
  it('distinguishes cloud media from local media incompleteness', () => {
    expect(
      recoveryFailureMessage('cloud-authoritative media incomplete: 2 missing, 0 corrupt'),
    ).toEqual({
      key: `${K}failed_cloud_media_incomplete`,
      params: { missing: '2', corrupt: '0' },
    })
  })

  // The mid-download probe words the shortfall differently from the preflight
  // gate ("… during media download: … bytes free, have …").
  it('parses the mid-download disk shortfall wording', () => {
    expect(
      recoveryFailureMessage(
        'insufficient free disk during media download: need at least 2097152 bytes free, have 1048576',
      ),
    ).toEqual({
      key: `${K}blocked_insufficient_disk`,
      params: { needed: '2.0 MB', available: '1.0 MB' },
    })
  })

  it('maps a partial upload', () => {
    expect(recoveryFailureMessage('channel upload completed with errors: 3')).toEqual({
      key: `${K}failed_upload_incomplete`,
    })
  })

  // Every literal `release_recovery_lease` can raise, with the key it must
  // land on. Verbatim from `src-tauri/src/sync/recovery.rs`.
  const LEASE_RELEASE_LITERALS: [string, string][] = [
    ['cannot release a recovery lease owned by another job', 'failed_lease_lost'],
    ['cannot delete a recovery marker owned by another job', 'failed_lease_lost'],
    ['released recovery control still has a live marker', 'failed_fence_release'],
    ['recovery marker changed before exact release', 'failed_fence_release'],
    ['recovery control changed before lease release', 'failed_fence_release'],
    ['persistent recovery control disappeared during release', 'failed_fence_release'],
    ['released control generation does not match the permit', 'failed_recovery_superseded'],
    ['recovery lease release readback was inconclusive', 'failed_lease_unconfirmed'],
  ]

  // `release_recovery_lease` reaches the UI through two callers: one wraps its
  // error as `fence release failed: …`, the other passes it through bare. Both
  // shapes must land on the same copy — a literal that diverges gets a
  // confident diagnosis on one path and raw text on the other.
  it.each(LEASE_RELEASE_LITERALS)('maps %s identically in both shapes', (literal, suffix) => {
    const bare = `auth: ${literal}`
    const wrapped = `fence release failed: auth: ${literal}`
    expect(recoveryFailureMessage(bare)).toEqual({ key: `${K}${suffix}` })
    expect(recoveryFailureMessage(wrapped)).toEqual({ key: `${K}${suffix}` })
  })

  // The permit-resume path raises this one, and it is the reachable case —
  // `resume_or_synthesize_permit` runs before the lease release ever happens.
  it('maps the permit-resume supersede wording', () => {
    expect(recoveryFailureMessage('control generation 5 does not match job 4')).toEqual({
      key: `${K}failed_recovery_superseded`,
    })
  })

  // Two near-misses that must NOT read as superseded: the first is a rival
  // holding OUR lease, the second is a mid-verification mismatch where the
  // lease may still be ours.
  it.each([
    ['recovery lease does not match the active job', 'failed_lease_lost'],
    ['control recovery_generation 5 != job 4', 'error'],
  ])('keeps %s out of the superseded branch', (raw, suffix) => {
    expect(recoveryFailureMessage(raw).key).toBe(`${K}${suffix}`)
  })

  // Acquisition-side readbacks share the release-side wording and meaning.
  it.each([
    'recovery lease readback did not confirm the exact winner',
    'recovery marker readback did not confirm the exact winner',
  ])('reads %s as an unconfirmed lock', (raw) => {
    expect(recoveryFailureMessage(`auth: ${raw}`)).toEqual({ key: `${K}failed_lease_unconfirmed` })
  })

  // All four db_key sites share one cause and one remedy; only a genuine
  // backup-writer failure is a backup problem.
  it.each([
    'db_key unavailable for recovery backup: locked',
    'db_key unavailable for staging: locked',
    'db_key unavailable for materialize: locked',
    'db_key unavailable for commit: locked',
    'db_key unavailable: Encryption key not initialized',
    // Same locked-key guard, different wording in the command wrappers.
    'sync key unavailable: Encryption key not initialized',
    'content/sync key unavailable: Encryption key not initialized',
  ])('maps %s to the key-unavailable message', (raw) => {
    expect(recoveryFailureMessage(raw)).toEqual({ key: `${K}failed_key_unavailable` })
  })

  it('keeps a genuine backup-writer failure separate', () => {
    expect(recoveryFailureMessage('recovery backup failed: disk full')).toEqual({
      key: `${K}blocked_backup_failed`,
    })
  })

  // A bare `unreadable` match sent this local-disk failure to "check your
  // internet connection" — the one thing that can never fix it.
  it('does not blame the network for an unreadable local original', () => {
    expect(
      recoveryFailureMessage(
        'local-authoritative prepare: media original unreadable and not staged: a1,b2',
      ),
    ).toEqual({ key: `${K}failed_local_media_unreadable` })
  })

  it('still maps the cloud-side unreadable probes', () => {
    expect(recoveryFailureMessage('control.json unreadable during verification: Io(x)')).toEqual({
      key: `${K}blocked_cloud_unreadable`,
    })
  })
})

// The suffix union makes a typo a compile error; this makes a suffix with no
// copy behind it a test failure, in either locale.
describe('locale coverage', () => {
  it.each(RECOVERY_MESSAGE_SUFFIXES)('%s has copy in en and vi', (suffix) => {
    expect(en.gdrive.help.recovery).toHaveProperty(suffix)
    expect(vi.gdrive.help.recovery).toHaveProperty(suffix)
  })

  it('pins the fallback key the confirm banner compares against', () => {
    expect(RECOVERY_FAILURE_FALLBACK_KEY).toBe(`${K}error`)
    expect(recoveryFailureMessage('something unmapped').key).toBe(RECOVERY_FAILURE_FALLBACK_KEY)
  })
})

describe('toRecoveryDirection', () => {
  it('passes through the two known operations', () => {
    expect(toRecoveryDirection('local_to_cloud')).toBe('local_to_cloud')
    expect(toRecoveryDirection('cloud_to_local')).toBe('cloud_to_local')
  })

  it('rejects anything else', () => {
    expect(toRecoveryDirection('cloud_cleanup')).toBeNull()
    expect(toRecoveryDirection(null)).toBeNull()
    expect(toRecoveryDirection(undefined)).toBeNull()
  })
})
