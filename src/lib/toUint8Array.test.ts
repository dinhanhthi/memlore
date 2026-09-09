import { describe, expect, it } from 'vitest'
import { toUint8Array } from './toUint8Array'

describe('toUint8Array', () => {
  it('returns a Uint8Array unchanged', () => {
    const input = new Uint8Array([1, 2, 3])
    expect(toUint8Array(input)).toBe(input)
  })

  it('wraps an ArrayBuffer', () => {
    const buf = new Uint8Array([4, 5, 6]).buffer
    expect(Array.from(toUint8Array(buf))).toEqual([4, 5, 6])
  })

  it('copies a typed-array view without including sibling bytes', () => {
    const backing = new Uint8Array([0, 7, 8, 9, 0])
    const view = new Uint8Array(backing.buffer, 1, 3)
    expect(Array.from(toUint8Array(view))).toEqual([7, 8, 9])
  })

  it('converts a number[] payload', () => {
    expect(Array.from(toUint8Array([10, 11, 12]))).toEqual([10, 11, 12])
  })

  it('throws on an unexpected payload type', () => {
    expect(() => toUint8Array('nope')).toThrow('unexpected payload type')
  })
})
