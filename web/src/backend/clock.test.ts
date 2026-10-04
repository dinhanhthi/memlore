import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertClockOk,
  ClockSkewError,
  getClockOffsetMs,
  nowSecs,
  resetClock,
  updateClockOffset,
} from './clock'
import { ERROR_NAMES } from './errorNames'

describe('clock', () => {
  beforeEach(() => {
    resetClock()
  })

  describe('nowSecs', () => {
    it('returns unix seconds and never milliseconds', () => {
      const fixedMs = 1775000000123 // ~April 2026 in ms
      const secs = nowSecs(fixedMs)
      expect(secs).toBe(1775000000)
      expect(secs).toBeLessThan(1e11)
      expect(Number.isInteger(secs)).toBe(true)
    })

    it('uses current Date.now() by default and is < 1e11', () => {
      const secs = nowSecs()
      expect(secs).toBeGreaterThan(1700000000)
      expect(secs).toBeLessThan(1e11)
    })

    it('applies server offset learned from Drive Date header', () => {
      const clientMs = 1775000000000
      // Server is 30 seconds ahead
      const serverDateHeader = new Date(clientMs + 30000).toUTCString()
      updateClockOffset(serverDateHeader, clientMs)

      expect(getClockOffsetMs()).toBe(30000)
      const secs = nowSecs(clientMs)
      expect(secs).toBe(1775000030)
    })
  })

  describe('updateClockOffset', () => {
    it('ignores invalid or unparseable Date header', () => {
      updateClockOffset('not-a-date', 1000)
      expect(getClockOffsetMs()).toBe(0)
    })

    it('calculates negative offset when browser clock is ahead of server', () => {
      const clientMs = 1775000050000
      const serverDateHeader = new Date(clientMs - 20000).toUTCString()
      updateClockOffset(serverDateHeader, clientMs)

      expect(getClockOffsetMs()).toBe(-20000)
      expect(nowSecs(clientMs)).toBe(1775000030)
    })
  })

  describe('assertClockOk', () => {
    it('does not throw before any server sample is received', () => {
      expect(() => assertClockOk()).not.toThrow()
    })

    it('does not throw when skew is within 120 seconds', () => {
      const clientMs = 1775000000000
      // 119 seconds ahead
      updateClockOffset(new Date(clientMs + 119000).toUTCString(), clientMs)
      expect(() => assertClockOk()).not.toThrow()

      // 120 seconds behind
      updateClockOffset(new Date(clientMs - 120000).toUTCString(), clientMs)
      expect(() => assertClockOk()).not.toThrow()
    })

    it('throws ClockSkewError when skew exceeds 120 seconds ahead', () => {
      const clientMs = 1775000000000
      // 121 seconds ahead
      updateClockOffset(new Date(clientMs + 121000).toUTCString(), clientMs)

      expect(() => assertClockOk()).toThrow(ClockSkewError)
      try {
        assertClockOk()
      } catch (err: unknown) {
        expect((err as Error).name).toBe(ERROR_NAMES.clockSkew)
        expect((err as ClockSkewError).skewSeconds).toBe(121)
      }
    })

    it('throws ClockSkewError when skew exceeds 120 seconds behind', () => {
      const clientMs = 1775000000000
      // 150 seconds behind
      updateClockOffset(new Date(clientMs - 150000).toUTCString(), clientMs)

      expect(() => assertClockOk()).toThrow(ClockSkewError)
      try {
        assertClockOk()
      } catch (err: unknown) {
        expect((err as Error).name).toBe(ERROR_NAMES.clockSkew)
        expect((err as ClockSkewError).skewSeconds).toBe(150)
      }
    })
  })

  describe('resetClock', () => {
    it('resets offset and sample state', () => {
      const clientMs = 1775000000000
      updateClockOffset(new Date(clientMs + 300000).toUTCString(), clientMs)
      expect(() => assertClockOk()).toThrow()

      resetClock()
      expect(getClockOffsetMs()).toBe(0)
      expect(() => assertClockOk()).not.toThrow()
    })
  })
})
