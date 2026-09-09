import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { parseVideoError, useVideoInsertPicker } from './useVideoInsertPicker'
import type { VideoActionResult } from './useVideoInsertPicker'
import * as tauri from '../lib/tauri'
import * as platform from '../lib/platform'

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    pickVideosFromLibrary: vi.fn(),
    pickVideo: vi.fn(),
  }
})

vi.mock('../lib/platform', () => ({
  isMacOS: vi.fn(() => true),
  detectPlatform: vi.fn(() => 'macos' as const),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}))

const mockPickVideosFromLibrary = vi.mocked(tauri.pickVideosFromLibrary)
const mockIsMacOS = vi.mocked(platform.isMacOS)

type EditorStub = {
  chain: () => {
    focus: () => { setVideo: (opts: unknown) => { run: () => boolean } }
    setVideo: (opts: unknown) => { run: () => boolean }
  }
}

function makeEditorStub(): { editor: EditorStub; setVideo: ReturnType<typeof vi.fn> } {
  const setVideo = vi.fn(() => ({ run: () => true }))
  const chainObj = {
    focus: () => ({ setVideo }),
    setVideo,
  }
  return {
    editor: { chain: () => chainObj },
    setVideo,
  }
}

// `parseVideoError` is load-bearing: the right-split on `:` exists precisely
// because filenames may contain colons. These tests pin that contract.
describe('parseVideoError', () => {
  it('parses the happy-path VIDEO_TOO_LARGE payload', () => {
    const result = parseVideoError('VIDEO_TOO_LARGE:clip.mp4:200')
    expect(result).toEqual({
      kind: 'video-too-large',
      filename: 'clip.mp4',
      maxSizeMb: 200,
    })
  })

  it('handles a filename that itself contains colons (the right-split case)', () => {
    // The filename `my:video:file.mov` contains two colons; a naive
    // left-split would truncate it. The right-split takes only the trailing
    // max_mb field and treats everything before it as the filename.
    const result = parseVideoError('VIDEO_TOO_LARGE:my:video:file.mov:500')
    expect(result).toEqual({
      kind: 'video-too-large',
      filename: 'my:video:file.mov',
      maxSizeMb: 500,
    })
  })

  it('falls back to maxSizeMb: 0 when the trailing field is not a number', () => {
    // The `|| 0` fallback in the parser guards against a malformed max_mb.
    const result = parseVideoError('VIDEO_TOO_LARGE:clip.mp4:notanumber')
    expect(result).toEqual({
      kind: 'video-too-large',
      filename: 'clip.mp4',
      maxSizeMb: 0,
    })
  })

  it('classifies an unrelated error string as unknown', () => {
    const result = parseVideoError('some other error')
    expect(result).toEqual({ kind: 'unknown', message: 'some other error' })
  })
})

describe('useVideoInsertPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMacOS.mockReturnValue(true)
  })

  it('insertInlineFromPhotoLibrary returns zero-saved on cancel (empty saved+rejected)', async () => {
    mockPickVideosFromLibrary.mockResolvedValueOnce({ saved: [], rejected: [] })
    const { editor, setVideo } = makeEditorStub()
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.insertInlineFromPhotoLibrary(editor as never, 'e1')
    })
    expect(out).toEqual({ saved: 0, insertedInline: false, rejected: [], error: null })
    expect(setVideo).not.toHaveBeenCalled()
  })

  it('insertInlineFromPhotoLibrary forwards rejected and leaves error null on a partial batch', async () => {
    mockPickVideosFromLibrary.mockResolvedValueOnce({
      saved: [{ mediaId: 'm1', localPath: '/tmp/a.mp4' }],
      rejected: ['oversized.mp4'],
    })
    const { editor, setVideo } = makeEditorStub()
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.insertInlineFromPhotoLibrary(editor as never, 'e1')
    })
    expect(out).toEqual({
      saved: 1,
      insertedInline: true,
      rejected: ['oversized.mp4'],
      error: null,
    })
    expect(setVideo).toHaveBeenCalledTimes(1)
  })

  it('insertInlineFromPhotoLibrary maps an all-rejected Err through parseVideoError with rejected: []', async () => {
    mockPickVideosFromLibrary.mockRejectedValueOnce('VIDEO_TOO_LARGE:clip.mp4:100')
    const { editor, setVideo } = makeEditorStub()
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.insertInlineFromPhotoLibrary(editor as never, 'e1')
    })
    expect(out).toEqual({
      saved: 0,
      insertedInline: false,
      rejected: [],
      error: { kind: 'video-too-large', filename: 'clip.mp4', maxSizeMb: 100 },
    })
    expect(setVideo).not.toHaveBeenCalled()
  })

  it('attachFromPhotoLibrary returns zero-saved on cancel (empty saved+rejected)', async () => {
    mockPickVideosFromLibrary.mockResolvedValueOnce({ saved: [], rejected: [] })
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.attachFromPhotoLibrary('e1')
    })
    expect(out).toEqual({ saved: 0, insertedInline: false, rejected: [], error: null })
    expect(mockPickVideosFromLibrary).toHaveBeenCalledWith('e1', 'attached')
  })

  it('attachFromPhotoLibrary forwards rejected and leaves error null on a partial batch', async () => {
    mockPickVideosFromLibrary.mockResolvedValueOnce({
      saved: [{ mediaId: 'm1', localPath: '/tmp/a.mp4' }],
      rejected: ['oversized.mp4'],
    })
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.attachFromPhotoLibrary('e1')
    })
    expect(out).toEqual({
      saved: 1,
      insertedInline: false,
      rejected: ['oversized.mp4'],
      error: null,
    })
  })

  it('attachFromPhotoLibrary maps an all-rejected Err through parseVideoError with rejected: []', async () => {
    mockPickVideosFromLibrary.mockRejectedValueOnce('VIDEO_TOO_LARGE:clip.mp4:100')
    const { result } = renderHook(() => useVideoInsertPicker())

    let out: VideoActionResult = { saved: -1, insertedInline: false, rejected: [], error: null }
    await act(async () => {
      out = await result.current.attachFromPhotoLibrary('e1')
    })
    expect(out).toEqual({
      saved: 0,
      insertedInline: false,
      rejected: [],
      error: { kind: 'video-too-large', filename: 'clip.mp4', maxSizeMb: 100 },
    })
  })
})
