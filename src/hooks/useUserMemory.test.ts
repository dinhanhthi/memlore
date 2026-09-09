import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  listMemoryItems: vi.fn(),
  updateMemoryItemText: vi.fn(),
  setMemoryEnabled: vi.fn(),
  deleteMemoryItem: vi.fn(),
  scanMemories: vi.fn(),
  consolidateMemories: vi.fn(),
  getPersona: vi.fn(),
  setPersonaEnabled: vi.fn(),
  writePersonaAnswers: vi.fn(),
  writePersonaUserEdit: vi.fn(),
  buildPersona: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { personaNeedsMoreStyleMaterial, useUserMemory } from './useUserMemory'

const ROW = {
  id: 'm1',
  text: 'Works as a marine biologist',
  sourceType: 'journal_entry',
  enabled: true,
  isDeleted: false,
  createdAt: 100,
  updatedAt: 110,
}

const PERSONA = {
  answersJson: '{"goal":"A calm place to reflect"}',
  traitsText: 'Reflective and practical',
  styleText: 'Warm, direct sentences.',
  enabled: true,
  userEdited: false,
  generatedAt: 120,
  updatedAt: 130,
}

beforeEach(() => {
  vi.mocked(tauri.getSetting).mockReset()
  vi.mocked(tauri.getSetting).mockResolvedValue(null)
  vi.mocked(tauri.listMemoryItems).mockReset()
  vi.mocked(tauri.updateMemoryItemText).mockReset()
  vi.mocked(tauri.setMemoryEnabled).mockReset()
  vi.mocked(tauri.deleteMemoryItem).mockReset()
  vi.mocked(tauri.scanMemories).mockReset()
  vi.mocked(tauri.consolidateMemories).mockReset()
  vi.mocked(tauri.consolidateMemories).mockResolvedValue(0)
  vi.mocked(tauri.getPersona).mockReset()
  vi.mocked(tauri.setPersonaEnabled).mockReset()
  vi.mocked(tauri.writePersonaAnswers).mockReset()
  vi.mocked(tauri.writePersonaUserEdit).mockReset()
  vi.mocked(tauri.buildPersona).mockReset()
})

describe('useUserMemory', () => {
  it('flags a completed traits-only build as needing more style material', () => {
    expect(
      personaNeedsMoreStyleMaterial({
        ...PERSONA,
        styleText: '',
        generatedAt: 120,
      }),
    ).toBe(true)
  })

  it('loads items on mount via list_memory_items', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(tauri.listMemoryItems).toHaveBeenCalledTimes(1)
    expect(result.current.items).toEqual([ROW])
    expect(result.current.loading).toBe(false)
  })

  it('keeps loading=false and items empty when list_memory_items rejects', async () => {
    vi.mocked(tauri.listMemoryItems).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
  })

  it('refresh() re-fetches and overwrites items', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValueOnce([ROW])
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    const row2 = { ...ROW, id: 'm2', text: 'Lives in Lisbon' }
    vi.mocked(tauri.listMemoryItems).mockResolvedValueOnce([row2])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.items).toEqual([row2])
  })

  it('editText() calls update_memory_item_text and patches local state on success', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.updateMemoryItemText).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    await act(async () => {
      await result.current.editText('m1', 'Edited text')
    })
    expect(tauri.updateMemoryItemText).toHaveBeenCalledWith('m1', 'Edited text')
    expect(result.current.items[0].text).toBe('Edited text')
  })

  it('editText() does NOT patch local state when the backend rejects', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.updateMemoryItemText).mockRejectedValue(new Error('nope'))
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    await expect(act(async () => result.current.editText('m1', ' Edited '))).rejects.toThrow('nope')
    // Local state untouched — the failed edit does not desync the list.
    expect(result.current.items[0].text).toBe('Works as a marine biologist')
  })

  it('setEnabled() calls set_memory_enabled and patches local state on success', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.setMemoryEnabled).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    await act(async () => {
      await result.current.setEnabled('m1', false)
    })
    expect(tauri.setMemoryEnabled).toHaveBeenCalledWith('m1', false)
    expect(result.current.items[0].enabled).toBe(false)
  })

  it('remove() calls delete_memory_item and drops the item locally on success', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.deleteMemoryItem).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    await act(async () => {
      await result.current.remove('m1')
    })
    expect(tauri.deleteMemoryItem).toHaveBeenCalledWith('m1')
    expect(result.current.items).toEqual([])
  })

  it('remove() keeps the item when the backend rejects', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.deleteMemoryItem).mockRejectedValue(new Error('locked'))
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))

    await expect(act(async () => result.current.remove('m1'))).rejects.toThrow('locked')
    expect(result.current.items).toEqual([ROW])
  })

  it('scan() calls scan_memories, stamps lastScannedAt, and refreshes', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.scanMemories).mockResolvedValue(3)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.items).toEqual([ROW]))
    expect(result.current.lastScannedAt).toBeNull()

    let claimed: number | undefined
    await act(async () => {
      claimed = await result.current.scan()
    })
    expect(tauri.scanMemories).toHaveBeenCalledTimes(1)
    // The tidy pass runs right after the scan claims sources.
    expect(tauri.consolidateMemories).toHaveBeenCalledTimes(1)
    expect(claimed).toBe(3)
    expect(result.current.lastScannedAt).not.toBeNull()
    // refresh() fired after the scan (list_memory_items called twice: mount + scan).
    expect(tauri.listMemoryItems).toHaveBeenCalledTimes(2)
  })

  it('scan() still resolves when the consolidation pass fails', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.scanMemories).mockResolvedValue(2)
    vi.mocked(tauri.consolidateMemories).mockRejectedValue(new Error('provider down'))
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let claimed: number | undefined
    await act(async () => {
      claimed = await result.current.scan()
    })
    // Consolidation is an enhancement — its failure must not lose the scan.
    expect(claimed).toBe(2)
    expect(result.current.lastScannedAt).not.toBeNull()
  })

  it('refetches when a memories-changed window event fires (post-sync fan-out)', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(tauri.listMemoryItems).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('memlore:memories-changed'))
    })
    await waitFor(() => expect(tauri.listMemoryItems).toHaveBeenCalledTimes(2))
  })

  it('lastScannedAt stays null before any scan', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lastScannedAt).toBeNull()
  })

  it('loads the persisted last-scanned timestamp on mount', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getSetting).mockResolvedValue('4242')
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(tauri.getSetting).toHaveBeenCalledWith('ai_memory_last_scanned_at')
    expect(result.current.lastScannedAt).toBe(4242)
  })

  it('hasEverScanned is false when nothing has ever scanned', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasEverScanned).toBe(false)
  })

  it('hasEverScanned is true when only the first-scan marker exists (legacy)', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    // Pre-change installs may have the write-once first-scan marker without
    // last_scanned (worker used to leave it alone). New scans stamp both.
    vi.mocked(tauri.getSetting).mockImplementation(async (key: string) =>
      key === 'ai_memory_first_scanned_at' ? '4242' : null,
    )
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasEverScanned).toBe(true)
    expect(result.current.lastScannedAt).toBeNull()
  })

  it('loads lastScannedAt from a worker-stamped timestamp (no manual press)', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getSetting).mockImplementation(async (key: string) => {
      if (key === 'ai_memory_last_scanned_at') return '9001'
      if (key === 'ai_memory_first_scanned_at') return '4242'
      return null
    })
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasEverScanned).toBe(true)
    expect(result.current.lastScannedAt).toBe(9001)
  })

  it('hasEverScanned never regresses once the marker has been seen', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getSetting).mockImplementation(async (key: string) =>
      key === 'ai_memory_first_scanned_at' ? '4242' : null,
    )
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.hasEverScanned).toBe(true))

    // The backend marker is write-once, so a later read returning null can
    // only be a transient failure — never a reason to claim "never scanned".
    vi.mocked(tauri.getSetting).mockResolvedValue(null)
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.hasEverScanned).toBe(true)
  })

  it('ignores a non-numeric persisted last-scanned value', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getSetting).mockResolvedValue('abc')
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lastScannedAt).toBeNull()
  })

  it('loads the singleton persona with the memory list', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValue(PERSONA)
    const { result } = renderHook(() => useUserMemory())

    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))
    expect(tauri.getPersona).toHaveBeenCalledTimes(1)
  })

  it('setPersonaEnabled() persists then patches the singleton persona', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValue(PERSONA)
    vi.mocked(tauri.setPersonaEnabled).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))

    await act(async () => {
      await result.current.setPersonaEnabled(false)
    })

    expect(tauri.setPersonaEnabled).toHaveBeenCalledWith(false)
    expect(result.current.persona?.enabled).toBe(false)
  })

  it('editPersona() saves both sections together and marks them user-edited', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValue(PERSONA)
    vi.mocked(tauri.writePersonaUserEdit).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))

    await act(async () => {
      await result.current.editPersona('Personal values', 'Clear, concise prose')
    })

    expect(tauri.writePersonaUserEdit).toHaveBeenCalledWith(
      'Personal values',
      'Clear, concise prose',
    )
    expect(result.current.persona).toMatchObject({
      traitsText: 'Personal values',
      styleText: 'Clear, concise prose',
      userEdited: true,
    })
  })

  it('savePersonaAnswers() omits skipped answers, persists them, and keeps generated sections', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValue(PERSONA)
    vi.mocked(tauri.writePersonaAnswers).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))

    await act(async () => {
      await result.current.savePersonaAnswers({
        preferred_name: 'Minh',
        journal_goal: '   ',
      })
    })

    expect(tauri.writePersonaAnswers).toHaveBeenCalledWith('{"preferred_name":"Minh"}')
    expect(result.current.persona).toMatchObject({
      answersJson: '{"preferred_name":"Minh"}',
      traitsText: PERSONA.traitsText,
      styleText: PERSONA.styleText,
    })
  })

  it('savePersonaAnswers() rejects over-cap answers without invoking the backend', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValue(PERSONA)
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))

    await expect(
      act(async () => result.current.savePersonaAnswers({ preferred_name: 'x'.repeat(301) })),
    ).rejects.toThrow('300')
    expect(tauri.writePersonaAnswers).not.toHaveBeenCalled()
  })

  it('rebuildPersona() forces only after the caller has confirmed and refreshes the row', async () => {
    const rebuilt = { ...PERSONA, traitsText: 'Rebuilt', userEdited: false }
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([ROW])
    vi.mocked(tauri.getPersona).mockResolvedValueOnce(PERSONA).mockResolvedValueOnce(rebuilt)
    vi.mocked(tauri.buildPersona).mockResolvedValue({ styleReady: true })
    const { result } = renderHook(() => useUserMemory())
    await waitFor(() => expect(result.current.persona).toEqual(PERSONA))

    await act(async () => {
      await result.current.rebuildPersona(true)
    })

    expect(tauri.buildPersona).toHaveBeenCalledWith(true)
    expect(result.current.persona).toEqual(rebuilt)
  })
})
