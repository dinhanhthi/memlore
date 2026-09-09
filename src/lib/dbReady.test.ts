import { describe, it, expect, beforeEach, vi } from 'vitest'
import { __resetDbReadyListenersForTests, emitDbReady, onDbReady } from './dbReady'

beforeEach(() => {
  __resetDbReadyListenersForTests()
})

describe('dbReady — pub/sub', () => {
  it('emitDbReady invokes every registered listener', () => {
    const a = vi.fn()
    const b = vi.fn()
    onDbReady(a)
    onDbReady(b)

    emitDbReady()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('emitDbReady with zero listeners is a no-op', () => {
    // Must not throw.
    expect(() => emitDbReady()).not.toThrow()
  })

  it('onDbReady returns a working unsubscribe', () => {
    const a = vi.fn()
    const unsubscribe = onDbReady(a)

    unsubscribe()
    emitDbReady()

    expect(a).not.toHaveBeenCalled()
  })

  it('listeners fire on every emit (idempotency contract)', () => {
    const a = vi.fn()
    onDbReady(a)

    emitDbReady()
    emitDbReady()
    emitDbReady()

    expect(a).toHaveBeenCalledTimes(3)
  })

  it('a throwing listener does not block subsequent listeners', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = vi.fn()
    const thrower = vi.fn(() => {
      throw new Error('boom')
    })
    const after = vi.fn()

    onDbReady(before)
    onDbReady(thrower)
    onDbReady(after)

    emitDbReady()

    expect(before).toHaveBeenCalledTimes(1)
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveBeenCalledWith('[dbReady] listener threw:', expect.any(Error))
    consoleSpy.mockRestore()
  })

  it('a listener that subscribes during dispatch is NOT invoked on the same cycle', () => {
    // Without snapshotting the listener set, a re-entrant subscriber would
    // be included in the same iteration (Set spec) — easy footgun.
    const late = vi.fn()
    const reentrant = vi.fn(() => {
      onDbReady(late)
    })

    onDbReady(reentrant)
    emitDbReady()

    expect(reentrant).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()

    // The late subscriber IS registered, so it fires on the next emit.
    emitDbReady()
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('__resetDbReadyListenersForTests clears the registry', () => {
    const a = vi.fn()
    onDbReady(a)

    __resetDbReadyListenersForTests()
    emitDbReady()

    expect(a).not.toHaveBeenCalled()
  })
})
