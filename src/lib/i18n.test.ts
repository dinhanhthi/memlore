import { describe, it, expect, beforeAll } from 'vitest'
import { i18n, SUPPORTED_LANGUAGES, resolveSystemLanguage } from './i18n'

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init()
  }
})

describe('i18n', () => {
  it('initializes with en as default language', () => {
    expect(i18n.isInitialized).toBe(true)
    expect(i18n.language).toMatch(/^en/)
  })

  it('exposes English translations for proof keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Welcome back')
    expect(i18n.t('nav:settings')).toBe('Settings')
    expect(i18n.t('nav:all_entries')).toBe('Entries')
    expect(i18n.t('nav:sidebar.collapse')).toBe('Collapse sidebar')
    expect(i18n.t('language.title', { ns: 'settings' })).toBe('Language')
    expect(i18n.t('language.vietnamese', { ns: 'settings' })).toBe('Vietnamese')
    expect(i18n.t('attachment_strip.summary_photos', { ns: 'editor', count: 1 })).toBe('1 photo')
    expect(i18n.t('attachment_strip.summary_photos', { ns: 'editor', count: 3 })).toBe('3 photos')
    expect(i18n.t('attachment_strip.play_voice_memo_aria', { ns: 'editor' })).toBe(
      'Play voice memo',
    )
  })

  it('exposes Vietnamese translations for proof keys', async () => {
    await i18n.changeLanguage('vi')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Chào mừng trở lại')
    expect(i18n.t('nav:settings')).toBe('Cài đặt')
    expect(i18n.t('nav:all_entries')).toBe('Các mục')
    expect(i18n.t('nav:sidebar.collapse')).toBe('Thu gọn thanh bên')
    expect(i18n.t('language.title', { ns: 'settings' })).toBe('Ngôn ngữ')
    expect(i18n.t('language.english', { ns: 'settings' })).toBe('Tiếng Anh')
    expect(i18n.t('attachment_strip.summary_photos', { ns: 'editor', count: 1 })).toBe('1 ảnh')
    expect(i18n.t('attachment_strip.summary_photos', { ns: 'editor', count: 3 })).toBe('3 ảnh')
    expect(i18n.t('attachment_strip.play_voice_memo_aria', { ns: 'editor' })).toBe('Phát ghi âm')
  })

  it('round-trips between en and vi without losing keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Welcome back')
    await i18n.changeLanguage('vi')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Chào mừng trở lại')
    await i18n.changeLanguage('en')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Welcome back')
  })

  it('falls back to en when an unknown language is requested', async () => {
    await i18n.changeLanguage('de')
    expect(i18n.t('lock.welcome_back', { ns: 'auth' })).toBe('Welcome back')
    // Reset so sibling test files that share the i18next singleton don't
    // start observing `i18n.language === 'de'` in their initial render.
    await i18n.changeLanguage('en')
  })

  it('lists supported languages as en + vi', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'vi'])
  })
})

const DASHBOARD_CARD_KEYS = [
  'streak',
  'quick_stats',
  'prompt',
  'on_this_day',
  'mood_trend',
  'recent_entries',
  'ai_insights',
] as const

function dashboardPrompts(): unknown {
  return i18n.t('prompts', { ns: 'dashboard', returnObjects: true })
}

describe('dashboard namespace', () => {
  it('is registered next to stats', () => {
    const ns = i18n.options.ns
    const list = Array.isArray(ns) ? ns : [ns]
    expect(list).toContain('stats')
    expect(list).toContain('dashboard')
    expect(list.indexOf('dashboard')).toBe(list.indexOf('stats') + 1)
  })

  it('exposes English proof keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('title', { ns: 'dashboard' })).toBe('Home')
    expect(i18n.t('customize', { ns: 'dashboard' })).toBe('Customize')
    expect(i18n.t('insights.range_hint', { ns: 'dashboard' })).toBe('Last 30 days')
    expect(i18n.t('quick_stats.entries_7d', { ns: 'dashboard' })).toContain('Last 7 days')
    expect(i18n.t('quick_stats.entries_30d', { ns: 'dashboard' })).toContain('Last 30 days')
    expect(i18n.t('quick_stats.words_7d', { ns: 'dashboard' })).toContain('Last 7 days')
  })

  it('exposes Vietnamese proof keys', async () => {
    await i18n.changeLanguage('vi')
    expect(i18n.t('title', { ns: 'dashboard' })).toBe('Tổng quan')
    expect(i18n.t('customize', { ns: 'dashboard' })).toBe('Tùy chỉnh')
    await i18n.changeLanguage('en')
  })

  it('has every required nested key in both languages', async () => {
    const required = [
      'title',
      'customize',
      'customize_title',
      'customize_hint',
      'customize_reorder',
      'empty_all_hidden',
      ...DASHBOARD_CARD_KEYS.map((id) => `cards.${id}`),
      'quick_stats.entries_7d',
      'quick_stats.entries_30d',
      'quick_stats.words_7d',
      'prompt.another',
      'prompt.write_now',
      'on_this_day.empty',
      'recent.empty',
      'recent.open',
      'insights.generate',
      'insights.regenerate',
      'insights.enable_hint',
      'insights.enable_link',
      'insights.range_hint',
    ]
    for (const lng of ['en', 'vi'] as const) {
      await i18n.changeLanguage(lng)
      for (const key of required) {
        expect(i18n.exists(key, { ns: 'dashboard' }), `${lng}:${key}`).toBe(true)
        const value = i18n.t(key, { ns: 'dashboard' })
        expect(value, `${lng}:${key}`).not.toBe(key)
        expect(String(value).trim().length, `${lng}:${key}`).toBeGreaterThan(0)
      }
    }
    await i18n.changeLanguage('en')
  })

  it('ships at least 30 unique reflective prompts per language', async () => {
    for (const lng of ['en', 'vi'] as const) {
      await i18n.changeLanguage(lng)
      const prompts = dashboardPrompts()
      expect(Array.isArray(prompts), lng).toBe(true)
      const list = prompts as unknown[]
      expect(list.length, lng).toBeGreaterThanOrEqual(30)
      const strings = list.map((item) => {
        expect(typeof item, lng).toBe('string')
        const text = (item as string).trim()
        expect(text.length, lng).toBeGreaterThan(8)
        return text
      })
      expect(new Set(strings).size, lng).toBe(strings.length)
    }
    await i18n.changeLanguage('en')
  })
})

describe('resolveSystemLanguage', () => {
  it('returns "vi" when the navigator language starts with "vi"', () => {
    expect(resolveSystemLanguage('vi-VN')).toBe('vi')
    expect(resolveSystemLanguage('vi')).toBe('vi')
  })

  it('returns "en" when the navigator language starts with "en"', () => {
    expect(resolveSystemLanguage('en-US')).toBe('en')
    expect(resolveSystemLanguage('en')).toBe('en')
  })

  it('falls back to "en" for an unsupported language', () => {
    expect(resolveSystemLanguage('fr-FR')).toBe('en')
    expect(resolveSystemLanguage('ja')).toBe('en')
    expect(resolveSystemLanguage(undefined)).toBe('en')
    expect(resolveSystemLanguage('')).toBe('en')
  })
})
