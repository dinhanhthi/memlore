import { beforeEach, describe, expect, it, vi } from 'vitest'

// Web build: gdrive_begin_connect opens the sign-in popup itself, so the store must not also
// open authUrl (the web opener shim rejects http://localhost and would open a stray tab on https).
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>()
  return { ...actual, isWeb: true }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock('../lib/tauri', () => ({
  gdriveBeginConnect: vi.fn(),
  gdriveCompleteConnect: vi.fn(),
  gdriveCancelConnect: vi.fn(),
  cloudFolderConnect: vi.fn(),
}))
vi.mock('./syncStore', () => ({
  useSyncStore: {
    getState: () => ({
      syncNow: vi.fn(() => Promise.resolve()),
      refresh: vi.fn(() => Promise.resolve()),
    }),
  },
}))
vi.mock('../hooks/useForceRePair', () => ({
  useForceRePairStore: { getState: () => ({ setForceRePair: vi.fn() }) },
}))

import { openUrl } from '@tauri-apps/plugin-opener'
import * as tauri from '../lib/tauri'
import { useGdriveConnectStore, __resetGdriveConnectStoreForTests } from './gdriveConnectStore'

const beginConnect = tauri.gdriveBeginConnect as unknown as ReturnType<typeof vi.fn>
const completeConnect = tauri.gdriveCompleteConnect as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  __resetGdriveConnectStoreForTests()
  vi.mocked(openUrl).mockClear()
  beginConnect.mockResolvedValue({ authUrl: 'http://localhost:5176/api/config', sessionId: 's-1' })
  completeConnect.mockResolvedValue({ outcome: 'ready' })
})

describe('gdriveConnectStore.connect on web', () => {
  it('completes the connect without opening authUrl', async () => {
    await useGdriveConnectStore.getState().connect('pw')

    expect(openUrl).not.toHaveBeenCalled()
    expect(completeConnect).toHaveBeenCalledWith('s-1', 'pw')
    expect(useGdriveConnectStore.getState().status).toBe('success')
  })
})
