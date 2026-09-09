import { describe, expect, it } from 'vitest'
import {
  detectPlatform,
  getRecommendedPlatform,
  isPlatformEnabled,
  PLATFORM_DOWNLOADS,
} from './platform'

describe('detectPlatform', () => {
  it('detects macOS', () => {
    expect(
      detectPlatform({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      }),
    ).toBe('macos')
  })

  it('detects Windows', () => {
    expect(
      detectPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
    ).toBe('windows')
  })

  it('detects Linux', () => {
    expect(
      detectPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }),
    ).toBe('linux')
  })

  it('detects iOS from mobile user agent', () => {
    expect(
      detectPlatform({
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      }),
    ).toBe('ios')
  })

  it('detects iPadOS touch devices that report MacIntel', () => {
    expect(
      detectPlatform({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        maxTouchPoints: 5,
      }),
    ).toBe('ios')
  })

  it('detects Android', () => {
    expect(
      detectPlatform({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }),
    ).toBe('android')
  })

  it('returns unknown when no platform matches', () => {
    expect(detectPlatform({ platform: 'Plan9', userAgent: 'MysteryBrowser/1.0' })).toBe('unknown')
  })
})

describe('download availability', () => {
  it('enables only macOS', () => {
    expect(PLATFORM_DOWNLOADS.filter(isPlatformEnabled).map((platform) => platform.id)).toEqual([
      'macos',
    ])
    expect(
      PLATFORM_DOWNLOADS.filter((platform) => !isPlatformEnabled(platform)).map(
        (platform) => platform.id,
      ),
    ).toEqual(['windows', 'linux', 'ios', 'android'])
  })

  it('returns the recommended platform when it exists', () => {
    expect(getRecommendedPlatform({ platform: 'Win32', userAgent: 'Windows' })?.id).toBe('windows')
  })
})
