import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomId', () => {
  it('uses crypto.randomUUID when available', () => {
    const uuid = '11111111-1111-4111-8111-111111111111'
    vi.stubGlobal('crypto', { randomUUID: () => uuid })
    expect(randomId()).toBe(uuid)
  })

  it('falls back to getRandomValues in an insecure context (no randomUUID)', () => {
    // Simulate http://LAN-IP where randomUUID is undefined but
    // getRandomValues still exists.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i
        return arr
      },
    })
    const id = randomId()
    expect(id).toMatch(UUID_RE)
    // Version 4 and RFC 4122 variant bits.
    expect(id[14]).toBe('4')
    expect(['8', '9', 'a', 'b']).toContain(id[19].toLowerCase())
  })

  it('falls back to Math.random when Web Crypto is entirely absent', () => {
    vi.stubGlobal('crypto', undefined)
    const id = randomId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('produces unique ids on repeated calls', () => {
    vi.unstubAllGlobals()
    const ids = new Set(Array.from({ length: 100 }, () => randomId()))
    expect(ids.size).toBe(100)
  })
})
