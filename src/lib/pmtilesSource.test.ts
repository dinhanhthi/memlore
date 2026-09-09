import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tauri', () => ({
  readBasemapRange: vi.fn(),
}))

import { readBasemapRange } from './tauri'
import { BasemapPmtilesSource, getBasemapPmtiles, resetBasemapPmtilesCache } from './pmtilesSource'

const mockedRead = vi.mocked(readBasemapRange)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('BasemapPmtilesSource', () => {
  it('getBytes fetches once then serves the LRU hit', async () => {
    mockedRead.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const src = new BasemapPmtilesSource()

    const first = await src.getBytes(0, 3)
    const second = await src.getBytes(0, 3)

    expect(mockedRead).toHaveBeenCalledTimes(1)
    expect(mockedRead).toHaveBeenCalledWith(0, 3)
    expect(new Uint8Array(first.data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(second.data)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('evicts the oldest range after 16 cached entries', async () => {
    mockedRead.mockImplementation(async (offset: number) => new Uint8Array([offset & 0xff]))
    const src = new BasemapPmtilesSource()

    for (let i = 0; i < 17; i++) {
      await src.getBytes(i, 1)
    }

    mockedRead.mockClear()
    mockedRead.mockResolvedValue(new Uint8Array([0]))
    await src.getBytes(0, 1)

    expect(mockedRead).toHaveBeenCalledTimes(1)
    expect(mockedRead).toHaveBeenCalledWith(0, 1)
  })

  it('resetBasemapPmtilesCache drops the shared PMTiles handle', () => {
    const first = getBasemapPmtiles()
    expect(getBasemapPmtiles()).toBe(first)
    resetBasemapPmtilesCache()
    expect(getBasemapPmtiles()).not.toBe(first)
  })

  it('distinct ranges each call readBasemapRange', async () => {
    mockedRead.mockImplementation(async (offset: number, len: number) => {
      return new Uint8Array(len).fill(offset & 0xff)
    })
    const src = new BasemapPmtilesSource()
    await src.getBytes(0, 4)
    await src.getBytes(8, 4)
    expect(mockedRead).toHaveBeenCalledTimes(2)
  })
})
