import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVideoPicker } from './useVideoPicker'

vi.mock('../lib/tauri', () => ({
  pickVideo: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
}))

import * as tauri from '../lib/tauri'
import { convertFileSrc } from '@tauri-apps/api/core'

const mockPickVideo = vi.mocked(tauri.pickVideo)
const mockConvertFileSrc = vi.mocked(convertFileSrc)

function makeMockEditor() {
  const run = vi.fn()
  const setVideoMock = vi.fn(() => ({ run }))
  const focusMock = vi.fn(() => ({
    setVideo: setVideoMock,
    run,
  }))
  const chainMock = vi.fn(() => ({ focus: focusMock }))
  return {
    chain: chainMock,
    _setVideo: setVideoMock,
    _run: run,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConvertFileSrc.mockImplementation((path: string) => `asset://localhost${path}`)
})

describe('useVideoPicker', () => {
  it('returns an insertVideo function', () => {
    const { result } = renderHook(() => useVideoPicker())
    expect(typeof result.current.insertVideo).toBe('function')
  })

  it('calls pickVideo with entryId and inserts a video node with src + data-media-id', async () => {
    mockPickVideo.mockResolvedValue({ mediaId: 'video-abc', localPath: '/Users/thi/clip.mp4' })
    const editor = makeMockEditor()

    const { result } = renderHook(() => useVideoPicker())
    await act(async () => {
      await result.current.insertVideo(editor as never, 'entry-xyz')
    })

    expect(mockPickVideo).toHaveBeenCalledWith('entry-xyz', 'inline')
    expect(mockConvertFileSrc).toHaveBeenCalledWith('/Users/thi/clip.mp4')
    expect(editor.chain).toHaveBeenCalled()
    expect(editor._setVideo).toHaveBeenCalledWith({
      src: 'asset://localhost/Users/thi/clip.mp4',
      'data-media-id': 'video-abc',
    })
  })

  it('does nothing when user cancels (pickVideo returns null)', async () => {
    mockPickVideo.mockResolvedValue(null)
    const editor = makeMockEditor()

    const { result } = renderHook(() => useVideoPicker())
    await act(async () => {
      await result.current.insertVideo(editor as never, 'entry-123')
    })

    expect(mockConvertFileSrc).not.toHaveBeenCalled()
    expect(editor.chain).not.toHaveBeenCalled()
  })

  it('does nothing when pickVideo throws', async () => {
    mockPickVideo.mockRejectedValue(new Error('dialog closed'))
    const editor = makeMockEditor()

    const { result } = renderHook(() => useVideoPicker())
    await act(async () => {
      await result.current.insertVideo(editor as never, 'entry-123')
    })

    expect(editor.chain).not.toHaveBeenCalled()
  })
})
