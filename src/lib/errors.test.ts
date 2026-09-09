import { describe, it, expect, afterEach } from 'vitest'
import { i18n } from './i18n'
import { translateError } from './errors'

afterEach(() => {
  void i18n.changeLanguage('en')
})

describe('translateError', () => {
  it('returns the English string for a known code when language is en', () => {
    expect(translateError('network.offline')).toBe('You are offline. Please check your connection.')
  })

  it('returns the Vietnamese string for a known code when language is vi', async () => {
    await i18n.changeLanguage('vi')
    expect(translateError('network.offline')).toBe(
      'Bạn đang ngoại tuyến. Vui lòng kiểm tra kết nối.',
    )
  })

  it('returns the fallback string when the code is unknown and fallback is provided', () => {
    expect(translateError('unknown.code', 'Server error')).toBe('Server error')
  })

  it('returns the code itself when the code is unknown and no fallback is provided', () => {
    expect(translateError('unknown.code')).toBe('unknown.code')
  })

  it('returns correct English string for crypto.password_required', () => {
    expect(translateError('crypto.password_required')).toBe(
      'A password is required to perform this action.',
    )
  })
})
