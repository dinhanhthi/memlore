import { describe, expect, it } from 'vitest'
import { errMsg } from './errMsg'

describe('errMsg', () => {
  it('returns a string value unchanged', () => {
    expect(errMsg('already a message')).toBe('already a message')
  })

  it('returns Error.message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
  })

  it('stringifies a number', () => {
    expect(errMsg(42)).toBe('42')
  })

  it('stringifies null', () => {
    expect(errMsg(null)).toBe('null')
  })

  it('stringifies undefined', () => {
    expect(errMsg(undefined)).toBe('undefined')
  })
})
