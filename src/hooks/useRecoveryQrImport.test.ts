import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Mock both boundaries before importing the hook — never hit the real backend
// or the real native dialog.
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))
vi.mock('../lib/tauri', () => ({
  decodeRecoveryQrFile: vi.fn(),
  onboardValidatePassphrase: vi.fn(),
}))

import { open } from '@tauri-apps/plugin-dialog'
import { decodeRecoveryQrFile, onboardValidatePassphrase } from '../lib/tauri'
import { RECOVERY_QR_FILE_EXTENSIONS, useRecoveryQrImport } from './useRecoveryQrImport'

const mockedOpen = vi.mocked(open)
const mockedDecode = vi.mocked(decodeRecoveryQrFile)
const mockedValidate = vi.mocked(onboardValidatePassphrase)

const MNEMONIC = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ')

describe('useRecoveryQrImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts idle', () => {
    const { result } = renderHook(() => useRecoveryQrImport())
    expect(result.current.status).toEqual({ kind: 'idle' })
  })

  it('decodes the picked image and validates it against the cloud vault', async () => {
    mockedOpen.mockResolvedValue('/Users/me/Desktop/sheet-qr.png')
    mockedDecode.mockResolvedValue(MNEMONIC)
    mockedValidate.mockResolvedValue(undefined)

    const { result } = renderHook(() => useRecoveryQrImport('session-42'))
    let outcome
    await act(async () => {
      outcome = await result.current.importFromImage()
    })

    expect(mockedOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: 'Recovery sheet or image', extensions: RECOVERY_QR_FILE_EXTENSIONS }],
      }),
    )
    expect(mockedDecode).toHaveBeenCalledWith('/Users/me/Desktop/sheet-qr.png')
    // The decoded phrase MUST go through the same cloud check the typed path
    // uses, session id included — the QR route is not a weaker second door.
    expect(mockedValidate).toHaveBeenCalledWith(MNEMONIC, 'session-42')
    expect(outcome).toEqual({ kind: 'imported', mnemonic: MNEMONIC })
    expect(result.current.status).toEqual({ kind: 'imported', mnemonic: MNEMONIC })
  })

  it('reports cancelled and decodes nothing when the user dismisses the dialog', async () => {
    mockedOpen.mockResolvedValue(null)

    const { result } = renderHook(() => useRecoveryQrImport())
    let outcome
    await act(async () => {
      outcome = await result.current.importFromImage()
    })

    expect(mockedDecode).not.toHaveBeenCalled()
    expect(mockedValidate).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(result.current.status).toEqual({ kind: 'cancelled' })
  })

  it('treats an undefined dialog result as cancelled too', async () => {
    // Some dialog versions resolve `undefined` rather than `null`.
    mockedOpen.mockResolvedValue(undefined as unknown as string)

    const { result } = renderHook(() => useRecoveryQrImport())
    await act(async () => {
      await result.current.importFromImage()
    })

    expect(mockedDecode).not.toHaveBeenCalled()
    expect(result.current.status).toEqual({ kind: 'cancelled' })
  })

  it('surfaces an unreadable image without ever validating', async () => {
    mockedOpen.mockResolvedValue('/Users/me/Desktop/cat.png')
    // Tauri rejects with plain strings.
    mockedDecode.mockRejectedValue('No QR code found in image')

    const { result } = renderHook(() => useRecoveryQrImport())
    let outcome
    await act(async () => {
      outcome = await result.current.importFromImage()
    })

    expect(mockedValidate).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'error', message: 'No QR code found in image' })
    expect(result.current.status).toEqual({ kind: 'error', message: 'No QR code found in image' })
  })

  it('surfaces a decoded-but-wrong-vault phrase as an error', async () => {
    mockedOpen.mockResolvedValue('/Users/me/Desktop/other-vault.png')
    // Syntactically valid BIP39 — it decodes fine, but belongs to another vault.
    mockedDecode.mockResolvedValue(MNEMONIC)
    mockedValidate.mockRejectedValue('Wrong recovery phrase for this vault')

    const { result } = renderHook(() => useRecoveryQrImport())
    let outcome
    await act(async () => {
      outcome = await result.current.importFromImage()
    })

    expect(outcome).toEqual({ kind: 'error', message: 'Wrong recovery phrase for this vault' })
    expect(result.current.status).toEqual({
      kind: 'error',
      message: 'Wrong recovery phrase for this vault',
    })
  })

  it('surfaces an Error object rejection too', async () => {
    mockedOpen.mockResolvedValue('/Users/me/Desktop/sheet-qr.png')
    mockedDecode.mockRejectedValue(new Error('Could not open image: permission denied'))

    const { result } = renderHook(() => useRecoveryQrImport())
    await act(async () => {
      await result.current.importFromImage()
    })

    expect(result.current.status).toEqual({
      kind: 'error',
      message: 'Could not open image: permission denied',
    })
  })

  it('reset() clears an error back to idle', async () => {
    mockedOpen.mockResolvedValue('/Users/me/Desktop/cat.png')
    mockedDecode.mockRejectedValue('No QR code found in image')

    const { result } = renderHook(() => useRecoveryQrImport())
    await act(async () => {
      await result.current.importFromImage()
    })
    act(() => result.current.reset())

    expect(result.current.status).toEqual({ kind: 'idle' })
  })
})
