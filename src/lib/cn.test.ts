import { describe, it, expect } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('merges class strings', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('resolves conflicting Tailwind utilities — last wins', () => {
    expect(cn('py-2', 'py-1.5')).toBe('py-1.5')
  })

  it('resolves w-full vs w-24 conflict', () => {
    expect(cn('w-full', 'w-24')).toBe('w-24')
  })

  it('ignores falsy values', () => {
    expect(cn('px-2', undefined, false, null, 'py-1')).toBe('px-2 py-1')
  })

  it('returns empty string when no args', () => {
    expect(cn()).toBe('')
  })
})
