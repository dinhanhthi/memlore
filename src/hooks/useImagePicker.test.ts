import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImagePicker } from './useImagePicker'
import type { ImageActionResult } from './useImageInsertPicker'

// Mock tauri.ts
vi.mock('../lib/tauri', () => ({
  pickImage: vi.fn(),
}))

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
}))

import * as tauri from '../lib/tauri'
import { convertFileSrc } from '@tauri-apps/api/core'

const mockPickImage = vi.mocked(tauri.pickImage)
const mockConvertFileSrc = vi.mocked(convertFileSrc)

// Minimal TipTap Editor mock that chains correctly
function makeMockEditor() {
  const run = vi.fn()
  const updateAttributesMock = vi.fn(() => ({ run }))
  const setImageMock = vi.fn(() => ({ run }))
  const focusMock = vi.fn(() => ({
    setImage: setImageMock,
    updateAttributes: updateAttributesMock,
    run,
  }))
  const chainMock = vi.fn(() => ({ focus: focusMock }))
  return {
    chain: chainMock,
    _setImage: setImageMock,
    _updateAttributes: updateAttributesMock,
    _run: run,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConvertFileSrc.mockImplementation((path: string) => `asset://localhost${path}`)
})

describe('useImagePicker — pickInlineImage', () => {
  it('pickInlineImage calls editor setImage with correct src and data-media-id', async () => {
    mockPickImage.mockResolvedValue({ mediaId: 'media-abc', localPath: '/Users/thi/photo.png' })
    const editor = makeMockEditor()

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickInlineImage(editor as never, 'entry-xyz')
    })

    expect(mockPickImage).toHaveBeenCalledWith('entry-xyz', 'inline')
    expect(mockConvertFileSrc).toHaveBeenCalledWith('/Users/thi/photo.png')
    expect(editor.chain).toHaveBeenCalled()
    expect(editor._setImage).toHaveBeenCalledWith({
      src: 'asset://localhost/Users/thi/photo.png',
      'data-media-id': 'media-abc',
    })
    expect(out).toEqual({ saved: 1, insertedInline: true, error: null })
  })

  it('pickInlineImage returns zero-saved on cancel (pickImage returns null)', async () => {
    mockPickImage.mockResolvedValue(null)
    const editor = makeMockEditor()

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickInlineImage(editor as never, 'entry-123')
    })

    expect(mockConvertFileSrc).not.toHaveBeenCalled()
    expect(editor.chain).not.toHaveBeenCalled()
    expect(out).toEqual({ saved: 0, insertedInline: false, error: null })
  })

  it('pickInlineImage surfaces a typed error when pickImage throws', async () => {
    mockPickImage.mockRejectedValue('IMAGE_TOO_LARGE:9999:1048576:cannot compress')
    const editor = makeMockEditor()

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickInlineImage(editor as never, 'entry-123')
    })

    expect(editor.chain).not.toHaveBeenCalled()
    expect(out).toEqual({
      saved: 0,
      insertedInline: false,
      error: { kind: 'image-too-large', actualBytes: 9999, limitBytes: 1048576 },
    })
  })
})

describe('useImagePicker — pickAttachedImage', () => {
  it('pickAttachedImage does not touch editor', async () => {
    mockPickImage.mockResolvedValue({ mediaId: 'media-att', localPath: '/path/photo.jpg' })
    const editor = makeMockEditor()

    const { result } = renderHook(() => useImagePicker())
    await act(async () => {
      await result.current.pickAttachedImage('entry-xyz')
    })

    expect(mockPickImage).toHaveBeenCalledWith('entry-xyz', 'attached')
    // editor must NOT be touched
    expect(editor.chain).not.toHaveBeenCalled()
  })

  it('pickAttachedImage returns saved=1 on success', async () => {
    mockPickImage.mockResolvedValue({ mediaId: 'media-att', localPath: '/path/photo.jpg' })

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickAttachedImage('entry-xyz')
    })

    expect(out).toEqual({ saved: 1, insertedInline: false, error: null })
  })

  it('pickAttachedImage returns zero-saved (no error) when cancelled', async () => {
    mockPickImage.mockResolvedValue(null)

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickAttachedImage('entry-123')
    })

    expect(out).toEqual({ saved: 0, insertedInline: false, error: null })
    expect(mockPickImage).toHaveBeenCalledWith('entry-123', 'attached')
  })

  it('pickAttachedImage surfaces a typed error when pickImage throws', async () => {
    mockPickImage.mockRejectedValue('IMAGE_TOO_LARGE:9999:1048576:cannot compress')

    const { result } = renderHook(() => useImagePicker())
    let out: ImageActionResult = {} as ImageActionResult
    await act(async () => {
      out = await result.current.pickAttachedImage('entry-123')
    })

    expect(out).toEqual({
      saved: 0,
      insertedInline: false,
      error: { kind: 'image-too-large', actualBytes: 9999, limitBytes: 1048576 },
    })
    expect(mockPickImage).toHaveBeenCalledWith('entry-123', 'attached')
  })
})
