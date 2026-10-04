import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import { DriveReader } from '../drive/client'
import { bytes, FakeDrive, fixtureBytes, loadDesktopFixture, seedFromFixture } from '../drive/fakeDrive'
import {
  assertRecoveryFence,
  getWritePauseReason,
  isWritesPaused,
  pauseWrites,
  resumeWrites,
  setRevalidationPullHandler,
  type ExpectedVaultState,
} from './fence'
import { isFormatGuardLatched, resetFormatGuardLatch } from './formatGuard'
import { FormatUnsupportedError, readMeta, readVersions } from './onboard'

function removeFile(drive: FakeDrive, path: string[]) {
  const target = drive.find(path)
  if (target) {
    drive.files = drive.files.filter((f) => f.id !== target.id)
  }
}

function setFileContent(drive: FakeDrive, path: string[], content: string | Uint8Array) {
  const target = drive.find(path)
  if (target) {
    target.content = typeof content === 'string' ? bytes(content) : content
  }
}

describe('Recovery fence (Phase 15.1)', () => {
  let core: Core
  let drive: FakeDrive
  let reader: DriveReader
  let expected: ExpectedVaultState

  beforeAll(async () => {
    core = await loadCore()
  })

  beforeEach(async () => {
    resumeWrites()
    resetFormatGuardLatch()
    setRevalidationPullHandler(null)
    drive = new FakeDrive()
    const fixture = loadDesktopFixture()
    seedFromFixture(drive, fixture)
    reader = new DriveReader({
      getToken: async () => 'tok',
      fetchImpl: drive.fetch,
    })

    // Baseline matching desktop fixture
    const initialMeta = await readMeta(reader, core, readVersions(core))
    expected = {
      recoveryGeneration: 0,
      masterFingerprint: initialMeta.masterFingerprint,
      epoch: initialMeta.epoch,
      contentEpoch: initialMeta.contentEpoch,
    }
  })

  it('allows write batch when control and meta match expected state without lease', async () => {
    const res = await assertRecoveryFence({ reader, core, expected })
    expect(res.control.recoveryGeneration).toBe(0)
    expect(res.control.leaseActive).toBe(false)
    expect(res.meta.masterFingerprint).toBe(expected.masterFingerprint)
    expect(res.meta.epoch).toBe(expected.epoch)
    expect(res.meta.contentEpoch).toBe(expected.contentEpoch)
    expect(isWritesPaused()).toBe(false)
  })

  it('refuses when control.json is missing', async () => {
    removeFile(drive, ['Memlore', '.meta', 'control.json'])
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'Control file is missing',
    )
    expect(isWritesPaused()).toBe(true)
    expect(getWritePauseReason()).toContain('Control file is missing')
  })

  it('refuses when _meta.json is missing', async () => {
    removeFile(drive, ['Memlore', '.meta', 'keyring', '_meta.json'])
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      '_meta.json is missing',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when recovery lease is active in control.json', async () => {
    setFileContent(
      drive,
      ['Memlore', '.meta', 'control.json'],
      JSON.stringify({
        version: 1,
        recovery_generation: 1,
        recovery_lease: {
          version: 1,
          job_id: 123,
          owner_device_id: '11111111-1111-1111-1111-111111111111',
          operation: 'cloud_cleanup',
          recovery_generation: 1,
          nonce: '0123456789abcdef0123456789abcdef',
          created_at: 1000,
          updated_at: 1000,
        },
        updated_at: 1000,
      }),
    )

    expected.recoveryGeneration = 1
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'recovery lease is active',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when generation is ahead of local record', async () => {
    setFileContent(
      drive,
      ['Memlore', '.meta', 'control.json'],
      JSON.stringify({
        version: 1,
        recovery_generation: 1,
        recovery_lease: null,
        updated_at: 1000,
      }),
    )

    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'recovery generation mismatch',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when generation is behind local record', async () => {
    expected.recoveryGeneration = 2
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'recovery generation mismatch',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when master fingerprint changed', async () => {
    expected.masterFingerprint = 'f'.repeat(64)
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'Master key fingerprint changed',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when epoch changed', async () => {
    expected.epoch = 99
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'Keyring epoch changed',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('refuses when content epoch changed', async () => {
    expected.contentEpoch = 99
    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      'Content epoch changed',
    )
    expect(isWritesPaused()).toBe(true)
  })

  it('invokes revalidatePull handler on refusal', async () => {
    const revalidatePull = vi.fn()
    removeFile(drive, ['Memlore', '.meta', 'control.json'])

    await expect(
      assertRecoveryFence({ reader, core, expected, revalidatePull }),
    ).rejects.toThrow()

    expect(revalidatePull).toHaveBeenCalledTimes(1)
  })

  it('invokes globally registered revalidationPullHandler on refusal when local handler is not passed', async () => {
    const globalRevalidate = vi.fn()
    setRevalidationPullHandler(globalRevalidate)
    removeFile(drive, ['Memlore', '.meta', 'control.json'])

    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow()
    expect(globalRevalidate).toHaveBeenCalledTimes(1)
  })

  it('resumeWrites clears pause flag and reason', () => {
    pauseWrites('testing')
    expect(isWritesPaused()).toBe(true)
    expect(getWritePauseReason()).toBe('testing')

    resumeWrites()
    expect(isWritesPaused()).toBe(false)
    expect(getWritePauseReason()).toBeNull()
  })

  it('latches format guard and throws FormatUnsupportedError when control.json has unknown fields', async () => {
    setFileContent(
      drive,
      ['Memlore', '.meta', 'control.json'],
      JSON.stringify({
        version: 1,
        recovery_generation: 0,
        recovery_lease: null,
        updated_at: 1000,
        unknown_new_field: 'newer-server',
      }),
    )

    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      FormatUnsupportedError,
    )
    expect(isFormatGuardLatched()).toBe(true)
  })

  it('latches format guard and throws FormatUnsupportedError when _meta.json has unknown fields', async () => {
    const fixture = loadDesktopFixture()
    const metaObj = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_meta.json')),
    ) as Record<string, unknown>
    metaObj.future_flag = true
    setFileContent(
      drive,
      ['Memlore', '.meta', 'keyring', '_meta.json'],
      JSON.stringify(metaObj),
    )

    await expect(assertRecoveryFence({ reader, core, expected })).rejects.toThrow(
      FormatUnsupportedError,
    )
    expect(isFormatGuardLatched()).toBe(true)
  })
})
