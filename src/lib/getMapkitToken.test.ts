import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { getMapkitToken } from './getMapkitToken'

const mockedInvoke = vi.mocked(invoke)

describe('getMapkitToken', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns available token when invoke yields a non-empty JWT', async () => {
    mockedInvoke.mockResolvedValue('  jwt.example.token  ')

    await expect(getMapkitToken()).resolves.toEqual({
      available: true,
      token: 'jwt.example.token',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('get_mapkit_token')
  })

  it('returns unavailable when the token is empty', async () => {
    mockedInvoke.mockResolvedValue('')

    await expect(getMapkitToken()).resolves.toEqual({ available: false })
  })

  it('returns unavailable when the token is whitespace', async () => {
    mockedInvoke.mockResolvedValue('   \n\t  ')

    await expect(getMapkitToken()).resolves.toEqual({ available: false })
  })

  it('returns unavailable when reject message contains MAPKIT_TOKEN_MISSING', async () => {
    mockedInvoke.mockRejectedValue(new Error('backend: MAPKIT_TOKEN_MISSING (unset)'))

    await expect(getMapkitToken()).resolves.toEqual({ available: false })
  })

  it('returns unavailable when reject is a MAPKIT_TOKEN_MISSING string', async () => {
    mockedInvoke.mockRejectedValue('MAPKIT_TOKEN_MISSING')

    await expect(getMapkitToken()).resolves.toEqual({ available: false })
  })

  it('rethrows any other reject', async () => {
    const err = new Error('db not ready')
    mockedInvoke.mockRejectedValue(err)

    await expect(getMapkitToken()).rejects.toBe(err)
  })
})
