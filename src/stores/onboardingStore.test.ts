import { describe, expect, it, beforeEach } from 'vitest'
import { useOnboardingStore } from './onboardingStore'

describe('useOnboardingStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.setState({
      pending: false,
      celebrationPending: false,
      celebrationVariant: 'setup',
    })
  })

  it('defaults pending and celebrationPending to false', () => {
    expect(useOnboardingStore.getState().pending).toBe(false)
    expect(useOnboardingStore.getState().celebrationPending).toBe(false)
  })

  it('setPending() sets pending to true without arming celebration', () => {
    useOnboardingStore.getState().setPending()
    expect(useOnboardingStore.getState().pending).toBe(true)
    expect(useOnboardingStore.getState().celebrationPending).toBe(false)
  })

  it('clearPending() clears pending and arms celebration once', () => {
    useOnboardingStore.setState({ pending: true, celebrationPending: false })
    useOnboardingStore.getState().clearPending()
    expect(useOnboardingStore.getState().pending).toBe(false)
    expect(useOnboardingStore.getState().celebrationPending).toBe(true)
  })

  it('dismissCelebration() clears celebrationPending', () => {
    useOnboardingStore.setState({ celebrationPending: true })
    useOnboardingStore.getState().dismissCelebration()
    expect(useOnboardingStore.getState().celebrationPending).toBe(false)
  })

  it('clearPending() defaults the celebration copy to the setup variant', () => {
    // A device that finished the wizard without Drive must not inherit a
    // stale sync-oriented variant from an earlier arm.
    useOnboardingStore.setState({ pending: true, celebrationVariant: 'joined-sync' })
    useOnboardingStore.getState().clearPending()
    expect(useOnboardingStore.getState().celebrationVariant).toBe('setup')
  })

  it('clearPending("setup-sync") arms the Drive-linked wizard celebration', () => {
    useOnboardingStore.setState({ pending: true, celebrationPending: false })
    useOnboardingStore.getState().clearPending('setup-sync')
    const s = useOnboardingStore.getState()
    expect(s.pending).toBe(false)
    expect(s.celebrationPending).toBe(true)
    expect(s.celebrationVariant).toBe('setup-sync')
  })

  it('clearPending() coerces an unknown variant to setup', () => {
    useOnboardingStore.setState({ pending: true })
    useOnboardingStore.getState().clearPending('confetti' as never)
    expect(useOnboardingStore.getState().celebrationVariant).toBe('setup')
  })

  it('armJoinCelebration() arms the celebration with the joined-sync variant', () => {
    useOnboardingStore.getState().armJoinCelebration()
    const s = useOnboardingStore.getState()
    expect(s.celebrationPending).toBe(true)
    expect(s.celebrationVariant).toBe('joined-sync')
    // The join path never runs the wizard — arming must not route the user
    // into it.
    expect(s.pending).toBe(false)
  })

  describe('onRehydrateStorage coercion', () => {
    const getOptions = () => useOnboardingStore.persist.getOptions()

    it('coerces a non-boolean stored pending value (string) to false', () => {
      const state = {
        pending: 'yes' as unknown as boolean,
        celebrationPending: false,
      }
      expect(() =>
        getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined),
      ).not.toThrow()
      expect(state.pending).toBe(false)
    })

    it('coerces a non-boolean stored pending value (null) to false', () => {
      const state = {
        pending: null as unknown as boolean,
        celebrationPending: false,
      }
      expect(() =>
        getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined),
      ).not.toThrow()
      expect(state.pending).toBe(false)
    })

    it('keeps a valid stored pending: true value as true', () => {
      const state = { pending: true, celebrationPending: false }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.pending).toBe(true)
    })

    it('coerces a non-boolean celebrationPending value to false', () => {
      const state = {
        pending: false,
        celebrationPending: 'yes' as unknown as boolean,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationPending).toBe(false)
    })

    it('keeps a valid celebrationPending: true value as true', () => {
      const state = { pending: false, celebrationPending: true }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationPending).toBe(true)
    })

    it('coerces an unknown celebrationVariant to setup', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'confetti' as unknown as 'setup',
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('setup')
    })

    it('keeps a valid stored joined-sync variant', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'joined-sync' as const,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('joined-sync')
    })

    it('keeps a valid stored setup-sync variant', () => {
      const state = {
        pending: false,
        celebrationPending: true,
        celebrationVariant: 'setup-sync' as const,
      }
      getOptions().onRehydrateStorage?.(state as never)?.(state as never, undefined)
      expect(state.celebrationVariant).toBe('setup-sync')
    })

    it('does not throw when state is undefined', () => {
      expect(() =>
        getOptions().onRehydrateStorage?.(undefined as never)?.(undefined as never, undefined),
      ).not.toThrow()
    })
  })
})
