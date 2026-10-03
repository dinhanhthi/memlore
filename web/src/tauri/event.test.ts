import { describe, expect, it, vi } from 'vitest'
import { emit, emitFromBackend, listen, once } from './event'

describe('web event shim', () => {
  it('delivers backend events to listeners with the payload', async () => {
    const fn = vi.fn()
    await listen<number>('t:a', fn)
    emitFromBackend('t:a', 7)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn.mock.calls[0][0]).toMatchObject({ event: 't:a', payload: 7 })
  })

  it('stops delivering after unlisten', async () => {
    const fn = vi.fn()
    const unlisten = await listen('t:b', fn)
    unlisten()
    emitFromBackend('t:b')
    expect(fn).not.toHaveBeenCalled()
  })

  it('once fires a single time', async () => {
    const fn = vi.fn()
    await once('t:c', fn)
    await emit('t:c', 1)
    await emit('t:c', 2)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('a throwing listener does not block others', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = vi.fn()
    await listen('t:d', () => {
      throw new Error('boom')
    })
    await listen('t:d', ok)
    emitFromBackend('t:d')
    expect(ok).toHaveBeenCalledOnce()
    err.mockRestore()
  })
})
