/**
 * Vitest cases for the pure `warmupVisibility` selector (Phase 5 Task 3).
 *
 * No `.test.tsx` — this covers the state-transition contract only; the
 * `ModelWarmupModal` component itself is verified via tsc + build + DOM
 * review per the project's no-component-tests rule.
 */
import { describe, expect, it } from 'vitest'
import {
  WARMUP_FLICKER_GUARD_MS,
  warmupVisibility,
  type WarmupVisibilityOpts,
} from './warmupVisibility'

const BASE = (overrides: Partial<WarmupVisibilityOpts>): WarmupVisibilityOpts => ({
  generationProvider: 'on-device-llm',
  serverState: 'starting',
  startingSince: 1000,
  now: 1000 + WARMUP_FLICKER_GUARD_MS, // exactly at the guard boundary
  userDismissed: false,
  ...overrides,
})

describe('warmupVisibility', () => {
  it('returns hidden for every server state when the provider is not on-device-llm', () => {
    const states = ['stopped', 'starting', 'ready', 'failed'] as const
    for (const serverState of states) {
      expect(
        warmupVisibility(
          BASE({
            generationProvider: 'ollama',
            serverState,
            startingSince: serverState === 'starting' ? 1000 : null,
          }),
        ),
      ).toBe('hidden')
    }
    // Also when no provider is configured at all.
    for (const serverState of states) {
      expect(
        warmupVisibility(
          BASE({
            generationProvider: null,
            serverState,
            startingSince: serverState === 'starting' ? 1000 : null,
          }),
        ),
      ).toBe('hidden')
    }
  })

  it('returns hidden when starting has lasted less than the flicker guard', () => {
    expect(
      warmupVisibility(BASE({ startingSince: 1000, now: 1000 + WARMUP_FLICKER_GUARD_MS - 1 })),
    ).toBe('hidden')
  })

  it('returns visible when starting has lasted >= the flicker guard', () => {
    // Exactly at the boundary (>= comparison).
    expect(
      warmupVisibility(BASE({ startingSince: 1000, now: 1000 + WARMUP_FLICKER_GUARD_MS })),
    ).toBe('visible')
    // Well past the boundary.
    expect(warmupVisibility(BASE({ startingSince: 1000, now: 5000 }))).toBe('visible')
  })

  it('returns hidden when startingSince is null even if state is starting (defensive)', () => {
    expect(
      warmupVisibility(BASE({ serverState: 'starting', startingSince: null, now: 999999 })),
    ).toBe('hidden')
  })

  it('returns hidden when the server is ready (auto-dismiss)', () => {
    expect(warmupVisibility(BASE({ serverState: 'ready', startingSince: null }))).toBe('hidden')
  })

  it('returns hidden when the server is stopped', () => {
    expect(warmupVisibility(BASE({ serverState: 'stopped', startingSince: null }))).toBe('hidden')
  })

  it('returns failed when the server is failed (even mid-flicker-window)', () => {
    // Failed wins over the flicker guard and over userDismissed=false.
    expect(warmupVisibility(BASE({ serverState: 'failed', startingSince: null, now: 0 }))).toBe(
      'failed',
    )
  })

  it('returns hidden when userDismissed is true, even if starting has lasted > guard', () => {
    expect(warmupVisibility(BASE({ userDismissed: true, startingSince: 1000, now: 10000 }))).toBe(
      'hidden',
    )
  })

  it('userDismissed takes precedence over failed (dismissal is sticky until the next cycle)', () => {
    // The component resets `userDismissed` to false at the START of a new
    // `starting` cycle; once the user has dismissed, they stay dismissed
    // through the rest of that cycle — including a later `failed` transition
    // (the picker / footer chip surfaces the failure instead).
    expect(
      warmupVisibility(BASE({ userDismissed: true, serverState: 'failed', startingSince: null })),
    ).toBe('hidden')
  })

  it('with userDismissed=false, starting+>=guard is visible (documents the reset contract)', () => {
    // This pins the selector half of the reset contract: the component is
    // responsible for flipping `userDismissed` back to false when a NEW
    // `starting` cycle begins (its useEffect on `startingSince`), at which
    // point the selector must report `visible` again.
    expect(
      warmupVisibility(
        BASE({ userDismissed: false, startingSince: 9000, now: 9000 + WARMUP_FLICKER_GUARD_MS }),
      ),
    ).toBe('visible')
  })
})
