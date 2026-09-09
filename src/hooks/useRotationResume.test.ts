import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRotationResume, useRotationResumeStore } from './useRotationResume'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

/** Fire the event with the new struct payload (mirrors Rust RotationResumePayload). */
const fireRotationResume = (jobState: string, isRevoke = false) => {
  handlers['xj://rotation-resume-required']?.({
    payload: { state: jobState, is_revoke: isRevoke },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  // Reset Zustand store between tests
  useRotationResumeStore.setState({ resumeRequired: false, jobState: null, isRevoke: false })
})

describe('useRotationResume', () => {
  it('starts with resumeRequired false, jobState null, isRevoke false', () => {
    const { result } = renderHook(() => useRotationResume())
    expect(result.current.resumeRequired).toBe(false)
    expect(result.current.jobState).toBeNull()
    expect(result.current.isRevoke).toBe(false)
  })

  it('sets resumeRequired and jobState when event fires (rotate job)', async () => {
    const { result } = renderHook(() => useRotationResume())
    await waitFor(() => expect(handlers['xj://rotation-resume-required']).toBeDefined())

    act(() => {
      fireRotationResume('reencrypt', false)
    })

    expect(result.current.resumeRequired).toBe(true)
    expect(result.current.jobState).toBe('reencrypt')
    expect(result.current.isRevoke).toBe(false)
  })

  it('sets isRevoke true when event fires with a revoke job', async () => {
    const { result } = renderHook(() => useRotationResume())
    await waitFor(() => expect(handlers['xj://rotation-resume-required']).toBeDefined())

    act(() => {
      fireRotationResume('reencrypt', true)
    })

    expect(result.current.resumeRequired).toBe(true)
    expect(result.current.jobState).toBe('reencrypt')
    expect(result.current.isRevoke).toBe(true)
  })

  it('captures the job state string from the event payload', async () => {
    const { result } = renderHook(() => useRotationResume())
    await waitFor(() => expect(handlers['xj://rotation-resume-required']).toBeDefined())

    act(() => {
      fireRotationResume('commit_local')
    })

    expect(result.current.jobState).toBe('commit_local')
  })

  it('clears state after clearResumeRequired() is called', async () => {
    const { result } = renderHook(() => useRotationResume())
    await waitFor(() => expect(handlers['xj://rotation-resume-required']).toBeDefined())

    act(() => {
      fireRotationResume('reencrypt', true)
    })
    expect(result.current.resumeRequired).toBe(true)
    expect(result.current.isRevoke).toBe(true)

    act(() => {
      result.current.clearResumeRequired()
    })

    expect(result.current.resumeRequired).toBe(false)
    expect(result.current.jobState).toBeNull()
    expect(result.current.isRevoke).toBe(false)
  })

  it('removes event listener on unmount', async () => {
    const { unmount } = renderHook(() => useRotationResume())
    await waitFor(() => expect(handlers['xj://rotation-resume-required']).toBeDefined())

    unmount()

    expect(handlers['xj://rotation-resume-required']).toBeUndefined()
  })

  it('store.setResumeRequired() can be called imperatively', () => {
    const { result } = renderHook(() => useRotationResume())
    expect(result.current.resumeRequired).toBe(false)

    act(() => {
      useRotationResumeStore
        .getState()
        .setResumeRequired({ state: 'enumerate_stragglers', is_revoke: false })
    })

    expect(result.current.resumeRequired).toBe(true)
    expect(result.current.jobState).toBe('enumerate_stragglers')
    expect(result.current.isRevoke).toBe(false)
  })
})
