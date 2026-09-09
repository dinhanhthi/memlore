import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  changeInvisibleVaultPassword,
  changeSecondLockPassword,
  disableSecondLock,
  getEncryptionMode,
  getStartupMode,
  getSyncRecoveryStatus,
  getTagsForEntries,
  getTagsWithCounts,
  listTags,
  gdriveBeginCloudAuthoritativeStaging,
  gdriveCancelSyncRecovery,
  gdriveCommitCloudAuthoritativeRestore,
  gdriveFinalizeLocalAuthoritativeRecovery,
  gdriveMaterializeCloudAuthoritativeStaging,
  gdrivePreflightLocalAuthoritativeRecovery,
  gdriveRebuildCloudFromLocal,
  gdriveResumeSyncRecovery,
  openOrCreateInvisibleVault,
  removeEmptyInvisibleVaults,
  secondLockStatus,
  importData,
  previewAppleJournalImport,
  writeAppleJournalImportReport,
  type ImportFormat,
  type ImportSummary,
  semanticSearch,
  setEntryLocked,
  setEntryInvisible,
  setJournalLocked,
  setJournalInvisible,
  setSecondLockPassword,
  SYNC_RECOVERY_STATUS_EVENT,
  syncRepairFromThisDevice,
  syncResetLocalState,
  verifySecondLockPassword,
  type SyncRecoveryStatus,
} from './tauri'

describe('getEncryptionMode', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes get_encryption_mode command', async () => {
    vi.mocked(invoke).mockResolvedValue('unset')
    await getEncryptionMode()
    expect(invoke).toHaveBeenCalledWith('get_encryption_mode')
  })

  it('returns unset when backend returns unset', async () => {
    vi.mocked(invoke).mockResolvedValue('unset')
    const result = await getEncryptionMode()
    expect(result).toBe('unset')
  })

  it('returns password when backend returns password', async () => {
    vi.mocked(invoke).mockResolvedValue('password')
    const result = await getEncryptionMode()
    expect(result).toBe('password')
  })

  it('returns none when backend returns none', async () => {
    vi.mocked(invoke).mockResolvedValue('none')
    const result = await getEncryptionMode()
    expect(result).toBe('none')
  })

  it('propagates rejection when backend errors', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('db not ready'))
    await expect(getEncryptionMode()).rejects.toThrow('db not ready')
  })
})

describe('getStartupMode', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes get_startup_mode command', async () => {
    vi.mocked(invoke).mockResolvedValue('password_locked')
    await getStartupMode()
    expect(invoke).toHaveBeenCalledWith('get_startup_mode')
  })

  it('returns boot_file_corrupt when backend reports corruption', async () => {
    vi.mocked(invoke).mockResolvedValue('boot_file_corrupt')
    await expect(getStartupMode()).resolves.toBe('boot_file_corrupt')
  })
})

describe('second lock wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('invokes second_lock_status without args', async () => {
    vi.mocked(invoke).mockResolvedValue(true)

    await expect(secondLockStatus()).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('second_lock_status')
  })

  it('invokes password commands with camelCase payloads', async () => {
    await setSecondLockPassword('secret')
    await changeSecondLockPassword('old', 'new')
    await verifySecondLockPassword('secret')
    await disableSecondLock('secret')

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_second_lock_password', { password: 'secret' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'change_second_lock_password', {
      oldPassword: 'old',
      newPassword: 'new',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'verify_second_lock_password', {
      password: 'secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'disable_second_lock', { password: 'secret' })
  })

  it('invokes lock toggles with entry and journal ids', async () => {
    await setEntryLocked('entry-1', true)
    await setJournalLocked('journal-1', false)

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_entry_locked', {
      entryId: 'entry-1',
      locked: true,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_journal_locked', {
      journalId: 'journal-1',
      locked: false,
    })
  })
})

describe('invisible lock wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('invokes open-or-create / change / remove-empty with backend payloads', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('vault-a')
      .mockResolvedValueOnce('vault-b')
      .mockResolvedValueOnce(undefined)

    await expect(openOrCreateInvisibleVault('secret')).resolves.toBe('vault-a')
    await expect(changeInvisibleVaultPassword('vault-a', 'old', 'new-secret')).resolves.toBe(
      'vault-b',
    )
    await removeEmptyInvisibleVaults()

    expect(invoke).toHaveBeenNthCalledWith(1, 'open_or_create_invisible_vault', {
      password: 'secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'change_invisible_vault_password', {
      vaultId: 'vault-a',
      current: 'old',
      new: 'new-secret',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'remove_empty_invisible_vaults')
  })

  it('invokes invisible toggles with entry/journal ids and activeVaultId', async () => {
    await setEntryInvisible('entry-1', true, 'vault-a')
    await setJournalInvisible('journal-1', false, null)

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_entry_invisible', {
      entryId: 'entry-1',
      invisible: true,
      activeVaultId: 'vault-a',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_journal_invisible', {
      journalId: 'journal-1',
      invisible: false,
      activeVaultId: null,
    })
  })
})

describe('tag wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue({})
  })

  it('invokes get_tags_for_entries with camelCase ids and activeVaultId', async () => {
    await getTagsForEntries(['entry-1', 'entry-2'])
    await getTagsForEntries(['entry-3'], 'vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_tags_for_entries', {
      entryIds: ['entry-1', 'entry-2'],
      activeVaultId: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_tags_for_entries', {
      entryIds: ['entry-3'],
      activeVaultId: 'vault-a',
    })
  })

  it('invokes list_tags with activeVaultId', async () => {
    await listTags()
    await listTags('vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'list_tags', { activeVaultId: null })
    expect(invoke).toHaveBeenNthCalledWith(2, 'list_tags', { activeVaultId: 'vault-a' })
  })

  it('invokes get_tags_with_counts with activeVaultId', async () => {
    await getTagsWithCounts()
    await getTagsWithCounts('vault-a')

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_tags_with_counts', { activeVaultId: null })
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_tags_with_counts', {
      activeVaultId: 'vault-a',
    })
  })
})

describe('search wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(invoke).mockResolvedValue([])
  })

  it('invokes semantic search with the locked-view and activeVaultId', async () => {
    await semanticSearch('query', 20, undefined, 'hidden', 'vault-a')

    expect(invoke).toHaveBeenCalledWith('semantic_search', {
      query: 'query',
      limit: 20,
      filters: undefined,
      lockedView: 'hidden',
      activeVaultId: 'vault-a',
    })
  })
})

describe('sync maintenance wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns queued reset outcome from backend', async () => {
    const outcome = { queued: true, result: null }
    vi.mocked(invoke).mockResolvedValue(outcome)

    await expect(syncResetLocalState()).resolves.toEqual(outcome)

    expect(invoke).toHaveBeenCalledWith('sync_reset_local_state')
  })

  it('returns repair result outcome from backend', async () => {
    const outcome = { queued: false, result: 3 }
    vi.mocked(invoke).mockResolvedValue(outcome)

    await expect(syncRepairFromThisDevice()).resolves.toEqual(outcome)

    expect(invoke).toHaveBeenCalledWith('sync_repair_from_this_device')
  })
})

describe('sync recovery wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const activeJob: SyncRecoveryStatus = {
    jobId: 7,
    operation: 'local_to_cloud',
    phase: 'backup',
    status: 'failed',
    recoveryGeneration: 3,
    backupPath: '/tmp/backup.memlore.zip',
    stagingPath: '/tmp/staging',
    verifiedCounts: { media_total: 2 },
    lastError: 'network: error sending request for url',
    isActive: true,
    blocksNormalSync: true,
    canResume: true,
    canCancelSafely: true,
    nextStep: 'local_rebuild',
    errorClass: 'retryable',
    createdAt: 100,
    updatedAt: 200,
  }

  it('uses a stable recovery status event name', () => {
    expect(SYNC_RECOVERY_STATUS_EVENT).toBe('sync:recovery-status-changed')
  })

  it('invokes get_sync_recovery_status and returns null when idle', async () => {
    vi.mocked(invoke).mockResolvedValue(null)
    await expect(getSyncRecoveryStatus()).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('get_sync_recovery_status')
  })

  it('returns a typed active recovery snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue(activeJob)
    await expect(getSyncRecoveryStatus()).resolves.toEqual(activeJob)
  })

  it('invokes cancel-safe and resume commands without args', async () => {
    vi.mocked(invoke).mockResolvedValue(activeJob)
    await expect(gdriveCancelSyncRecovery()).resolves.toEqual(activeJob)
    await expect(gdriveResumeSyncRecovery()).resolves.toEqual(activeJob)
    expect(invoke).toHaveBeenNthCalledWith(1, 'gdrive_cancel_sync_recovery')
    expect(invoke).toHaveBeenNthCalledWith(2, 'gdrive_resume_sync_recovery')
  })

  it('invokes local-authoritative start/resume step commands', async () => {
    const preflight = {
      jobId: 1,
      backupPath: '/b.zip',
      stagingPath: '/s',
      mediaTotal: 0,
      mediaLocal: 0,
      mediaDownloaded: 0,
    }
    const rebuild = {
      jobId: 1,
      phase: 'transfer',
      recoveryGeneration: 2,
      entriesAdopted: 1,
      journalsAdopted: 0,
      mediaPathsBound: 0,
      mediaReset: 0,
      versionsReset: 0,
      pushedEntries: 1,
      mediaUploaded: 0,
      versionsUploaded: 0,
      embeddingBatches: 0,
      pushErrors: [],
      keyringPublished: false,
    }
    const verify = {
      jobId: 1,
      phase: 'fence_release_pending',
      status: 'completed',
      recoveryGeneration: 2,
      postReleaseSyncErrors: [],
    }
    vi.mocked(invoke)
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce(rebuild)
      .mockResolvedValueOnce(verify)

    await expect(gdrivePreflightLocalAuthoritativeRecovery()).resolves.toEqual(preflight)
    await expect(gdriveRebuildCloudFromLocal()).resolves.toEqual(rebuild)
    await expect(gdriveFinalizeLocalAuthoritativeRecovery()).resolves.toEqual(verify)

    expect(invoke).toHaveBeenNthCalledWith(1, 'gdrive_preflight_local_authoritative_recovery')
    expect(invoke).toHaveBeenNthCalledWith(2, 'gdrive_rebuild_cloud_from_local')
    expect(invoke).toHaveBeenNthCalledWith(3, 'gdrive_finalize_local_authoritative_recovery')
  })

  it('invokes cloud-authoritative start/resume step commands', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ jobId: 2, backupPath: '/b', stagingPath: '/s' })
      .mockResolvedValueOnce({ jobId: 2, channels: [], mediaDownloaded: 0 })
      .mockResolvedValueOnce({ jobId: 2, phase: 'finalize', status: 'completed' })

    await gdriveBeginCloudAuthoritativeStaging()
    await gdriveMaterializeCloudAuthoritativeStaging()
    await gdriveCommitCloudAuthoritativeRestore()

    expect(invoke).toHaveBeenNthCalledWith(1, 'gdrive_begin_cloud_authoritative_staging')
    expect(invoke).toHaveBeenNthCalledWith(2, 'gdrive_materialize_cloud_authoritative_staging')
    expect(invoke).toHaveBeenNthCalledWith(3, 'gdrive_commit_cloud_authoritative_restore')
  })

  it('propagates terminal recovery failures from resume', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('competing recovery lease held by peer'))
    await expect(gdriveResumeSyncRecovery()).rejects.toThrow('competing recovery')
  })
})

describe('importData', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const existingFormats: ImportFormat[] = [
    'memlore_zip',
    'markdown_folder',
    'plain_text_folder',
    'dayone_zip',
    'journey_zip',
  ]

  it('forwards existing format wire names unchanged', async () => {
    vi.mocked(invoke).mockResolvedValue({ imported: 1, skippedDuplicates: 0, errors: [] })
    for (const format of existingFormats) {
      await importData('/tmp/src', format, 'merge_newer', null)
      expect(invoke).toHaveBeenCalledWith('import_data', {
        src: '/tmp/src',
        format,
        mode: 'merge_newer',
        journalId: null,
      })
    }
  })

  it('accepts apple_journal_folder and an additive apple report', async () => {
    const summary: ImportSummary = {
      imported: 2,
      skippedDuplicates: 0,
      errors: [],
      warnings: [{ kind: 'no_thumbnail', message: 'kept original' }],
      apple: {
        entriesImported: 2,
        entriesFailed: 0,
        resourcesReferenced: 3,
        resourcesImported: 2,
        resourcesMissing: 1,
        resourcesUnsupported: 0,
        resourcesUnreferenced: 0,
        entriesSkippedExact: 1,
        entriesSourceChanged: 2,
      },
    }
    vi.mocked(invoke).mockResolvedValue(summary)

    const result = await importData(
      '/tmp/apple-export',
      'apple_journal_folder',
      'merge_newer',
      'journal-1',
    )

    expect(invoke).toHaveBeenCalledWith('import_data', {
      src: '/tmp/apple-export',
      format: 'apple_journal_folder',
      mode: 'merge_newer',
      journalId: 'journal-1',
    })
    expect(result.imported).toBe(2)
    expect(result.apple?.entriesImported).toBe(2)
    expect(result.apple?.resourcesMissing).toBe(1)
    expect(result.apple?.entriesSkippedExact).toBe(1)
    expect(result.apple?.entriesSourceChanged).toBe(2)
    expect(result.warnings?.[0]?.kind).toBe('no_thumbnail')
  })

  it('forwards optional Apple import options only when provided', async () => {
    vi.mocked(invoke).mockResolvedValue({ imported: 1, skippedDuplicates: 0, errors: [] })

    await importData('/tmp/apple-export', 'apple_journal_folder', 'merge_newer', 'journal-1', {
      conversionTimezone: 'Europe/Berlin',
      expectedSourceHash: 'hash-abc',
    })

    expect(invoke).toHaveBeenCalledWith('import_data', {
      src: '/tmp/apple-export',
      format: 'apple_journal_folder',
      mode: 'merge_newer',
      journalId: 'journal-1',
      options: {
        conversionTimezone: 'Europe/Berlin',
        expectedSourceHash: 'hash-abc',
      },
    })
  })
})

describe('previewAppleJournalImport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes preview_apple_journal_import with src and optional options', async () => {
    const preview = {
      sourceHash: 'hash-abc',
      conversionTimezone: 'Europe/Berlin',
      datePolicy: 'html_visible' as const,
      datePrecision: 'date_only' as const,
      clockIsSynthetic: true,
      entries: 2,
      resourcesReferenced: 3,
      resourcesWouldImport: 3,
      resourcesMissing: 0,
      resourcesUnsupported: 0,
      resourcesUnreferenced: 0,
      warnings: [] as { kind: string; message: string }[],
    }
    vi.mocked(invoke).mockResolvedValue(preview)

    const result = await previewAppleJournalImport('/tmp/apple-export', {
      conversionTimezone: 'Europe/Berlin',
    })

    expect(invoke).toHaveBeenCalledWith('preview_apple_journal_import', {
      src: '/tmp/apple-export',
      options: { conversionTimezone: 'Europe/Berlin' },
    })
    expect(result.sourceHash).toBe('hash-abc')
    expect(result.entries).toBe(2)
    expect(result.clockIsSynthetic).toBe(true)
    expect(result.datePolicy).toBe('html_visible')
  })
})

describe('writeAppleJournalImportReport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes write_apple_journal_import_report with dest, text, and source', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)

    await writeAppleJournalImportReport(
      '/tmp/memlore-apple-journal-import-report.txt',
      'report body',
      '/export-a',
    )

    expect(invoke).toHaveBeenCalledWith('write_apple_journal_import_report', {
      dest: '/tmp/memlore-apple-journal-import-report.txt',
      text: 'report body',
      source: '/export-a',
    })
  })
})
