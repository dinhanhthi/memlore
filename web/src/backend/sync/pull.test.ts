import { describe, expect, it } from 'vitest'
import { createLimiter } from './pull'

describe('createLimiter', () => {
  it('never runs more than max tasks at once and completes them all', async () => {
    const limit = createLimiter(4)
    let active = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          active -= 1
          return i
        }),
      ),
    )
    expect(peak).toBe(4)
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('keeps going after a task throws', async () => {
    const limit = createLimiter(1)
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(limit(async () => 7)).resolves.toBe(7)
  })

  it('rejects an invalid max', () => {
    expect(() => createLimiter(0)).toThrow(RangeError)
  })
})
