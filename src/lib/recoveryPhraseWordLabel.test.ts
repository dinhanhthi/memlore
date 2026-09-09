import { describe, it, expect, beforeAll } from 'vitest'
import { i18n } from './i18n'
import { recoveryPhraseWordLabelKey } from './recoveryPhraseWordLabel'

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init()
  }
})

function labelFor(position: number, language = 'en'): string {
  const { key, ordinal } = recoveryPhraseWordLabelKey(position, language)
  return i18n.t(key, { ns: 'auth', ordinal })
}

describe('recoveryPhraseWordLabelKey', () => {
  it('maps the first, middle, penultimate, and last positions', async () => {
    await i18n.changeLanguage('en')
    expect(labelFor(1)).toBe('The first word')
    expect(labelFor(3)).toBe('The third word')
    expect(labelFor(23)).toBe('The second-to-last word')
    expect(labelFor(24)).toBe('The last word')
  })

  it('maps other positions to ordinal labels', async () => {
    await i18n.changeLanguage('en')
    expect(labelFor(11)).toBe('The eleventh word')
    expect(labelFor(22)).toBe('The twenty-second word')
  })

  it('maps Vietnamese labels for special positions and ordinals', async () => {
    await i18n.changeLanguage('vi')
    expect(labelFor(1, 'vi')).toBe('Chữ đầu tiên')
    expect(labelFor(3, 'vi')).toBe('Chữ thứ ba')
    expect(labelFor(23, 'vi')).toBe('Chữ kế cuối')
    expect(labelFor(24, 'vi')).toBe('Chữ cuối cùng')
  })

  it('rejects positions outside the 24-word phrase', () => {
    expect(() => recoveryPhraseWordLabelKey(0)).toThrow(/1–24/)
    expect(() => recoveryPhraseWordLabelKey(25)).toThrow(/1–24/)
  })
})
