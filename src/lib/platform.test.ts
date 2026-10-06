import { afterEach, describe, expect, it, vi } from 'vitest'

const NEW_CAPABILITY_FLAGS = [
  'gallery',
  'lookback',
  'taxonomyEdits',
  'deleteEntries',
  'audioRecording',
  'fileAttachments',
  'fontDownloads',
  'syncAdmin',
  'vaultAdmin',
]

async function load() {
  vi.resetModules()
  return import('./platform')
}

describe('platform', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('desktop: isWeb false and every capability true', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    const p = await load()
    expect(p.isWeb).toBe(false)
    expect(Object.keys(p.capabilities)).toEqual(expect.arrayContaining(NEW_CAPABILITY_FLAGS))
    expect(Object.values(p.capabilities).every((v) => v === true)).toBe(true)
  })

  it('web: isWeb true, isMacOS false even on a Mac UA, capabilities false', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    const p = await load()
    expect(p.isWeb).toBe(true)
    expect(p.isMacOS()).toBe(false)
    expect(Object.keys(p.capabilities)).toEqual(expect.arrayContaining(NEW_CAPABILITY_FLAGS))
    expect(Object.values(p.capabilities).every((v) => v === false)).toBe(true)
  })

  it('desktop: isMacOS follows the user agent', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    const p = await load()
    expect(p.isMacOS()).toBe(true)
  })
})
