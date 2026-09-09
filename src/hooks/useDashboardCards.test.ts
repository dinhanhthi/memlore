import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import {
  DEFAULT_DASHBOARD_CARDS,
  parseDashboardCards,
  serializeDashboardCards,
  type DashboardCardPref,
} from '../lib/dashboardCards'
import {
  __resetDashboardCardsForTests,
  getDashboardCards,
  hydrateDashboardCards,
  setDashboardCards,
  useDashboardCards,
} from './useDashboardCards'

const mockedInvoke = vi.mocked(invoke)

const STORED_PREFS: DashboardCardPref[] = [
  { id: 'ai_insights', enabled: false },
  { id: 'streak', enabled: true },
  { id: 'quick_stats', enabled: false },
  { id: 'prompt', enabled: true },
  { id: 'on_this_day', enabled: true },
  { id: 'mood_trend', enabled: false },
  { id: 'recent_entries', enabled: true },
]

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetDashboardCardsForTests()
})

describe('useDashboardCards', () => {
  it('defaults to DEFAULT_DASHBOARD_CARDS before hydration', () => {
    const { result } = renderHook(() => useDashboardCards())
    expect(result.current).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('hydrate parses stored JSON', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'dashboard_cards') {
        return serializeDashboardCards(STORED_PREFS)
      }
      return null
    })

    await hydrateDashboardCards()

    const { result } = renderHook(() => useDashboardCards())
    expect(result.current).toEqual(parseDashboardCards(serializeDashboardCards(STORED_PREFS)))
  })

  it('falls back to the default when hydrating garbage', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'dashboard_cards') {
        return 'garbage'
      }
      return null
    })

    await hydrateDashboardCards()

    const { result } = renderHook(() => useDashboardCards())
    expect(result.current).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('setDashboardCards writes serialized JSON under key dashboard_cards', async () => {
    const { result } = renderHook(() => useDashboardCards())

    await act(async () => {
      await setDashboardCards(STORED_PREFS)
    })

    await waitFor(() => {
      expect(result.current).toEqual(STORED_PREFS)
    })

    const setCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'set_setting')
    expect(setCall?.[1]).toEqual({
      key: 'dashboard_cards',
      value: serializeDashboardCards(STORED_PREFS),
    })
  })

  it('serializes persists so reverse completion cannot drop a toggle', async () => {
    let holdPersists = true
    const release: Array<() => void> = []
    const completed: DashboardCardPref[][] = []
    let inFlight = 0
    let maxInFlight = 0

    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'set_setting') {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          if (holdPersists) {
            await new Promise<void>((resolve) => {
              release.push(resolve)
            })
          }
          completed.push(JSON.parse((args as { value: string }).value) as DashboardCardPref[])
        } finally {
          inFlight -= 1
        }
      }
      return null
    })

    const firstWrite = setDashboardCards(
      getDashboardCards().map((pref) =>
        pref.id === 'streak' ? { ...pref, enabled: false } : pref,
      ),
    )

    await waitFor(() => {
      expect(release.length).toBe(1)
    })

    const secondWrite = setDashboardCards(
      getDashboardCards().map((pref) =>
        pref.id === 'prompt' ? { ...pref, enabled: false } : pref,
      ),
    )

    expect(getDashboardCards().find((pref) => pref.id === 'streak')?.enabled).toBe(false)
    expect(getDashboardCards().find((pref) => pref.id === 'prompt')?.enabled).toBe(false)
    // Second write must not start another set_setting while the first is held.
    expect(release.length).toBe(1)
    expect(maxInFlight).toBe(1)

    // Unblock the first persist AFTER the second write has already updated memory.
    holdPersists = false
    release[0]()

    await Promise.all([firstWrite, secondWrite])

    expect(maxInFlight).toBe(1)
    expect(getDashboardCards().find((pref) => pref.id === 'streak')?.enabled).toBe(false)
    expect(getDashboardCards().find((pref) => pref.id === 'prompt')?.enabled).toBe(false)

    expect(completed.length).toBeGreaterThan(0)
    const lastWrite = completed[completed.length - 1]
    expect(lastWrite?.find((pref) => pref.id === 'streak')?.enabled).toBe(false)
    expect(lastWrite?.find((pref) => pref.id === 'prompt')?.enabled).toBe(false)
  })

  it('hydrate after a settled write still applies a later stored value', async () => {
    const localWrite = DEFAULT_DASHBOARD_CARDS.map((pref) =>
      pref.id === 'streak' ? { ...pref, enabled: false } : pref,
    )
    await setDashboardCards(localWrite)
    expect(getDashboardCards()).toEqual(localWrite)

    const peer = DEFAULT_DASHBOARD_CARDS.map((pref) =>
      pref.id === 'prompt' ? { ...pref, enabled: false } : pref,
    )
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'dashboard_cards') {
        return serializeDashboardCards(peer)
      }
      return null
    })

    await hydrateDashboardCards()
    expect(getDashboardCards()).toEqual(peer)
  })

  it('keeps the optimistic write when persist fails then a stale hydrate resolves', async () => {
    let resolveGet: ((value: string | null) => void) | undefined
    let rejectSet: ((err: Error) => void) | undefined
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'dashboard_cards') {
        return new Promise<string | null>((resolve) => {
          resolveGet = resolve
        })
      }
      if (cmd === 'set_setting') {
        return new Promise<null>((_resolve, reject) => {
          rejectSet = reject
        })
      }
      return null
    })

    const localWrite = DEFAULT_DASHBOARD_CARDS.map((pref) =>
      pref.id === 'streak' ? { ...pref, enabled: false } : pref,
    )
    const persist = setDashboardCards(localWrite)
    const hydrate = hydrateDashboardCards()

    await waitFor(() => {
      expect(rejectSet).toBeTypeOf('function')
      expect(resolveGet).toBeTypeOf('function')
    })

    rejectSet?.(new Error('disk full'))
    await expect(persist).rejects.toThrow('disk full')

    resolveGet?.(serializeDashboardCards(DEFAULT_DASHBOARD_CARDS))
    await hydrate

    expect(getDashboardCards()).toEqual(DEFAULT_DASHBOARD_CARDS)
  })

  it('rolls overlapping failed persists back to the last disk snapshot', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'set_setting') throw new Error('disk full')
      return null
    })

    const first = setDashboardCards(
      getDashboardCards().map((pref) =>
        pref.id === 'streak' ? { ...pref, enabled: false } : pref,
      ),
    )
    const second = setDashboardCards(
      getDashboardCards().map((pref) =>
        pref.id === 'prompt' ? { ...pref, enabled: false } : pref,
      ),
    )

    await expect(first).rejects.toThrow('disk full')
    await expect(second).rejects.toThrow('disk full')
    expect(getDashboardCards()).toEqual(DEFAULT_DASHBOARD_CARDS)
  })
})
