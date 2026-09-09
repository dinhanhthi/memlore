import { describe, expect, it, vi } from 'vitest'

import { resumeRecoveryUntilSettled } from './resumeRecoveryUntilSettled'
import type { SyncRecoveryStatus } from './tauri'

function status(overrides: Partial<SyncRecoveryStatus>): SyncRecoveryStatus {
  return {
    jobId: 1,
    operation: 'cloud_to_local',
    phase: 'created',
    status: 'running',
    recoveryGeneration: 1,
    backupPath: null,
    stagingPath: null,
    verifiedCounts: {},
    lastError: null,
    isActive: true,
    blocksNormalSync: true,
    canResume: true,
    canCancelSafely: false,
    nextStep: null,
    errorClass: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('resumeRecoveryUntilSettled', () => {
  it('returns null without resuming when there is no job', async () => {
    const resume = vi.fn()
    await expect(resumeRecoveryUntilSettled(null, resume)).resolves.toBeNull()
    expect(resume).not.toHaveBeenCalled()
  })

  it('returns the initial status without resuming when the job is settled', async () => {
    const settled = status({ isActive: false, status: 'completed', phase: 'done' })
    const resume = vi.fn()
    await expect(resumeRecoveryUntilSettled(settled, resume)).resolves.toBe(settled)
    expect(resume).not.toHaveBeenCalled()
  })

  it('returns the status without resuming when the job cannot resume', async () => {
    const blocked = status({ canResume: false })
    const resume = vi.fn()
    await expect(resumeRecoveryUntilSettled(blocked, resume)).resolves.toBe(blocked)
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes step by step until the job settles', async () => {
    const steps = [
      status({ phase: 'backup' }),
      status({ phase: 'transfer' }),
      status({ phase: 'done', status: 'completed', isActive: false }),
    ]
    const resume = vi.fn(() => Promise.resolve(steps[resume.mock.calls.length - 1]))
    const final = await resumeRecoveryUntilSettled(status({ phase: 'created' }), resume)
    expect(final).toBe(steps[2])
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it('throws when a resume step makes no progress', async () => {
    const stuck = status({ phase: 'transfer', status: 'running' })
    const resume = vi.fn(() => Promise.resolve(stuck))
    await expect(resumeRecoveryUntilSettled(stuck, resume)).rejects.toThrow(
      /no progress at phase "transfer"/,
    )
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('propagates a resume failure unchanged', async () => {
    const resume = vi.fn(() => Promise.reject(new Error('backend down')))
    await expect(resumeRecoveryUntilSettled(status({}), resume)).rejects.toThrow('backend down')
  })
})
