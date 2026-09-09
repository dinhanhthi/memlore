import { describe, it, expect } from 'vitest'
import { passwordStrength, MIN_PASSWORD_LEN } from './passwordStrength'

describe('passwordStrength', () => {
  describe('below minimum length', () => {
    it('classifies empty string as weak', () => {
      expect(passwordStrength('')).toBe('weak')
    })

    it('classifies a 7-char password as weak regardless of variety', () => {
      expect(passwordStrength('Aa1!xyz')).toBe('weak')
    })
  })

  describe('predictable / low-entropy passwords at minimum length', () => {
    it('classifies "12345678" as weak (common sequence, digits only)', () => {
      expect(passwordStrength('12345678')).toBe('weak')
    })

    it('classifies "password" as weak (top dictionary word)', () => {
      expect(passwordStrength('password')).toBe('weak')
    })

    it('classifies "aaaaaaaa" as weak (repeated character)', () => {
      expect(passwordStrength('aaaaaaaa')).toBe('weak')
    })

    it('classifies "qwertyui" as weak (keyboard pattern)', () => {
      expect(passwordStrength('qwertyui')).toBe('weak')
    })
  })

  describe('medium-strength passwords', () => {
    it('classifies a mixed 10-char password without common patterns as at least fair', () => {
      const result = passwordStrength('Tr0ub4dor')
      expect(['fair', 'good', 'strong']).toContain(result)
    })
  })

  describe('strong passwords', () => {
    it('classifies a long random password with full variety as strong', () => {
      expect(passwordStrength('X9$mKp2qLw8!vR4nZt')).toBe('strong')
    })
  })

  describe('MIN_PASSWORD_LEN constant', () => {
    it('exports the minimum length', () => {
      expect(MIN_PASSWORD_LEN).toBe(8)
    })
  })
})
