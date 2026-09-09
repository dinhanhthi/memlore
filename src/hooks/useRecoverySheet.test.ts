import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Mock both boundaries before importing the hook — never hit the real backend
// or the real native dialog.
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}))
vi.mock('../lib/tauri', () => ({
  renderRecoverySheet: vi.fn(),
  exportStatsFile: vi.fn(),
}))

import { save } from '@tauri-apps/plugin-dialog'
import { exportStatsFile, renderRecoverySheet } from '../lib/tauri'
import { RECOVERY_SHEET_FILE_NAME, useRecoverySheet } from './useRecoverySheet'

const mockedSave = vi.mocked(save)
const mockedRender = vi.mocked(renderRecoverySheet)
const mockedWrite = vi.mocked(exportStatsFile)

const MNEMONIC = Array.from({ length: 24 }, (_, i) => `word${i + 1}`)
const SHEET_BYTES = new Uint8Array([60, 104, 116, 109, 108, 62])

describe('useRecoverySheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts idle', () => {
    const { result } = renderHook(() => useRecoverySheet())
    expect(result.current.status).toEqual({ kind: 'idle' })
  })

  it('renders the sheet and writes it to the path the user picked', async () => {
    mockedRender.mockResolvedValue(SHEET_BYTES)
    mockedSave.mockResolvedValue('/Users/me/Desktop/sheet.html')
    mockedWrite.mockResolvedValue(undefined)

    const { result } = renderHook(() => useRecoverySheet())
    let outcome
    await act(async () => {
      outcome = await result.current.saveSheet(MNEMONIC)
    })

    // The command takes the words as one space-separated string.
    expect(mockedRender).toHaveBeenCalledWith(MNEMONIC.join(' '))
    // The dialog only suggests a name — the user chooses the location.
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: RECOVERY_SHEET_FILE_NAME }),
    )
    expect(mockedWrite).toHaveBeenCalledWith('/Users/me/Desktop/sheet.html', SHEET_BYTES)
    expect(outcome).toEqual({ kind: 'saved', path: '/Users/me/Desktop/sheet.html' })
    expect(result.current.status).toEqual({ kind: 'saved', path: '/Users/me/Desktop/sheet.html' })
  })

  it('reports cancelled and writes nothing when the user dismisses the dialog', async () => {
    mockedRender.mockResolvedValue(SHEET_BYTES)
    mockedSave.mockResolvedValue(null)

    const { result } = renderHook(() => useRecoverySheet())
    let outcome
    await act(async () => {
      outcome = await result.current.saveSheet(MNEMONIC)
    })

    expect(mockedWrite).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(result.current.status).toEqual({ kind: 'cancelled' })
  })

  it('treats an undefined dialog result as cancelled too', async () => {
    mockedRender.mockResolvedValue(SHEET_BYTES)
    // Some dialog versions resolve `undefined` rather than `null`.
    mockedSave.mockResolvedValue(undefined as unknown as string)

    const { result } = renderHook(() => useRecoverySheet())
    await act(async () => {
      await result.current.saveSheet(MNEMONIC)
    })

    expect(mockedWrite).not.toHaveBeenCalled()
    expect(result.current.status).toEqual({ kind: 'cancelled' })
  })

  it('surfaces a render failure without ever opening the save dialog', async () => {
    // Tauri rejects with plain strings.
    mockedRender.mockRejectedValue('render_recovery_sheet: invalid mnemonic')

    const { result } = renderHook(() => useRecoverySheet())
    let outcome
    await act(async () => {
      outcome = await result.current.saveSheet(MNEMONIC)
    })

    expect(mockedSave).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      kind: 'error',
      message: 'render_recovery_sheet: invalid mnemonic',
    })
  })

  it('surfaces a write failure', async () => {
    mockedRender.mockResolvedValue(SHEET_BYTES)
    mockedSave.mockResolvedValue('/nope/sheet.html')
    mockedWrite.mockRejectedValue(new Error('Failed to write /nope/sheet.html'))

    const { result } = renderHook(() => useRecoverySheet())
    await act(async () => {
      await result.current.saveSheet(MNEMONIC)
    })

    expect(result.current.status).toEqual({
      kind: 'error',
      message: 'Failed to write /nope/sheet.html',
    })
  })
})
