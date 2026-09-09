import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { celebrationVariantForWizardDone, useOnboardingWizard } from './useOnboardingWizard'
import { useOnboardingStore } from '../stores/onboardingStore'
import {
  __resetGdriveConnectStoreForTests,
  useGdriveConnectStore,
} from '../stores/gdriveConnectStore'

beforeEach(() => {
  useOnboardingStore.setState({
    pending: true,
    celebrationPending: false,
    celebrationVariant: 'setup',
  })
  __resetGdriveConnectStoreForTests()
})

describe('celebrationVariantForWizardDone', () => {
  it('returns setup when Drive was skipped', () => {
    expect(celebrationVariantForWizardDone({ driveConnected: false, connectStatus: 'idle' })).toBe(
      'setup',
    )
  })

  it('returns setup-sync when the wizard shell saw Drive connected', () => {
    expect(celebrationVariantForWizardDone({ driveConnected: true, connectStatus: 'idle' })).toBe(
      'setup-sync',
    )
  })

  it('returns setup-sync when the connect store succeeded after DriveStep unmounted', () => {
    expect(
      celebrationVariantForWizardDone({ driveConnected: false, connectStatus: 'success' }),
    ).toBe('setup-sync')
  })

  // An in-flight connect can still fail, and `setup-sync` asserts the sync IS
  // running while suppressing the connect toast behind its modal — so a
  // failure would only surface (contradicting the modal) on dismiss.
  it('returns setup while a background connect is still in flight', () => {
    expect(
      celebrationVariantForWizardDone({
        driveConnected: false,
        connectStatus: 'connecting',
      }),
    ).toBe('setup')
  })

  it('returns setup-sync mid-connect when the shell already saw a connection', () => {
    expect(
      celebrationVariantForWizardDone({ driveConnected: true, connectStatus: 'connecting' }),
    ).toBe('setup-sync')
  })

  it('returns setup on a failed connect with no prior connection', () => {
    expect(celebrationVariantForWizardDone({ driveConnected: false, connectStatus: 'error' })).toBe(
      'setup',
    )
  })
})

describe('useOnboardingWizard', () => {
  it('starts on the theme step', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    expect(result.current.step).toEqual({ kind: 'theme' })
  })

  it('walks forward theme -> journal -> drive -> ai -> done via next()', () => {
    const { result } = renderHook(() => useOnboardingWizard())

    act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'journal' })

    act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'drive' })

    act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'ai' })

    act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'done' })
  })

  it('next() from done is a no-op', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    for (let i = 0; i < 4; i++) act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'done' })

    act(() => result.current.next())
    expect(result.current.step).toEqual({ kind: 'done' })
  })

  it('skip() advances from drive', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    act(() => result.current.next()) // journal
    act(() => result.current.next()) // drive
    expect(result.current.step).toEqual({ kind: 'drive' })

    act(() => result.current.skip())
    expect(result.current.step).toEqual({ kind: 'ai' })
  })

  it('skip() advances from ai', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    act(() => result.current.next()) // journal
    act(() => result.current.next()) // drive
    act(() => result.current.next()) // ai
    expect(result.current.step).toEqual({ kind: 'ai' })

    act(() => result.current.skip())
    expect(result.current.step).toEqual({ kind: 'done' })
  })

  it('back() moves backward through the linear order', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    act(() => result.current.next()) // journal
    act(() => result.current.next()) // drive
    expect(result.current.step).toEqual({ kind: 'drive' })

    act(() => result.current.back())
    expect(result.current.step).toEqual({ kind: 'journal' })

    act(() => result.current.back())
    expect(result.current.step).toEqual({ kind: 'theme' })
  })

  it('back() from the first step (theme) is a no-op', () => {
    const { result } = renderHook(() => useOnboardingWizard())
    expect(result.current.step).toEqual({ kind: 'theme' })

    act(() => result.current.back())
    expect(result.current.step).toEqual({ kind: 'theme' })
  })

  it('calls clearPending("setup") exactly once when reaching done without Drive', () => {
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    const { result } = renderHook(() => useOnboardingWizard())

    act(() => result.current.next()) // journal
    act(() => result.current.next()) // drive
    act(() => result.current.next()) // ai
    expect(clearPendingSpy).not.toHaveBeenCalled()

    act(() => result.current.next()) // done
    expect(clearPendingSpy).toHaveBeenCalledTimes(1)
    expect(clearPendingSpy).toHaveBeenCalledWith('setup')

    // A stray extra next() call after done must not re-trigger the side effect.
    act(() => result.current.next())
    expect(clearPendingSpy).toHaveBeenCalledTimes(1)

    clearPendingSpy.mockRestore()
  })

  it('calls clearPending("setup-sync") when Drive was connected during the wizard', () => {
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    const { result } = renderHook(() => useOnboardingWizard('theme', { driveConnected: true }))

    for (let i = 0; i < 4; i++) act(() => result.current.next())
    expect(clearPendingSpy).toHaveBeenCalledWith('setup-sync')
    expect(useOnboardingStore.getState().celebrationVariant).toBe('setup-sync')

    clearPendingSpy.mockRestore()
  })

  it('calls clearPending("setup-sync") when connect store succeeded even if shell flag lagged', () => {
    useGdriveConnectStore.setState({ status: 'success' })
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    const { result } = renderHook(() => useOnboardingWizard('theme', { driveConnected: false }))

    for (let i = 0; i < 4; i++) act(() => result.current.next())
    expect(clearPendingSpy).toHaveBeenCalledWith('setup-sync')

    clearPendingSpy.mockRestore()
  })

  it('calls clearPending("setup") when a background connect is still in flight', () => {
    // User can Next past Drive while OAuth I/O is still running; that connect
    // can still fail, so the wizard must not promise a running sync.
    useGdriveConnectStore.setState({ status: 'connecting' })
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    const { result } = renderHook(() => useOnboardingWizard('theme', { driveConnected: false }))

    for (let i = 0; i < 4; i++) act(() => result.current.next())
    expect(clearPendingSpy).toHaveBeenCalledWith('setup')

    clearPendingSpy.mockRestore()
  })

  // Locks in the `driveConnectedRef` indirection: re-rendering with a NEW
  // `driveConnected` after `done` must not re-run the effect and re-arm the
  // one-shot modal. Referencing the prop directly would need it in the deps
  // array, which does exactly that.
  it('does not re-arm the celebration when driveConnected flips after done', () => {
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    const { result, rerender } = renderHook(
      ({ driveConnected }) => useOnboardingWizard('theme', { driveConnected }),
      { initialProps: { driveConnected: false } },
    )

    for (let i = 0; i < 4; i++) act(() => result.current.next())
    expect(clearPendingSpy).toHaveBeenCalledTimes(1)

    rerender({ driveConnected: true })
    expect(clearPendingSpy).toHaveBeenCalledTimes(1)

    clearPendingSpy.mockRestore()
  })

  it('does not call clearPending() before reaching done', () => {
    const clearPendingSpy = vi.spyOn(useOnboardingStore.getState(), 'clearPending')
    renderHook(() => useOnboardingWizard())

    expect(clearPendingSpy).not.toHaveBeenCalled()
    clearPendingSpy.mockRestore()
  })
})
