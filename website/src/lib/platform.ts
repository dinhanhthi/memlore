export type PlatformId = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown'

export interface PlatformInput {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
}

export interface PlatformDownload {
  id: PlatformId
  name: string
  description: string
  availability: 'available' | 'coming-soon'
  ctaLabel: string
  href?: string
}

export const MACOS_DOWNLOAD_URL = 'https://github.com/dinhanhthi/memlore/releases'

export const PLATFORM_DOWNLOADS: PlatformDownload[] = [
  {
    id: 'macos',
    name: 'macOS',
    description:
      'Primary release target with Touch ID, Keychain, Google Drive sync, and the full desktop writing experience.',
    availability: 'available',
    ctaLabel: 'Download for macOS',
    href: MACOS_DOWNLOAD_URL,
  },
  {
    id: 'windows',
    name: 'Windows',
    description:
      'Planned desktop build with Windows Credential Manager support after the macOS v1.0 reference app is complete.',
    availability: 'coming-soon',
    ctaLabel: 'Coming soon',
  },
  {
    id: 'linux',
    name: 'Linux',
    description:
      'Planned AppImage and deb builds with Secret Service integration and verified desktop sync.',
    availability: 'coming-soon',
    ctaLabel: 'Coming soon',
  },
  {
    id: 'ios',
    name: 'iOS',
    description:
      'Planned mobile journaling with iOS Keychain, Face ID or Touch ID, and iCloud-first sync.',
    availability: 'coming-soon',
    ctaLabel: 'Coming soon',
  },
  {
    id: 'android',
    name: 'Android',
    description:
      'Planned tablet-first Android experience with Android Keystore and Google Drive sync.',
    availability: 'coming-soon',
    ctaLabel: 'Coming soon',
  },
]

export function detectPlatform(input: PlatformInput = {}): PlatformId {
  const userAgent = input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  const platform = input.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '')
  const maxTouchPoints =
    input.maxTouchPoints ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0)

  const ua = userAgent.toLowerCase()
  const os = platform.toLowerCase()

  if (/android/.test(ua)) return 'android'
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (os === 'macintel' && maxTouchPoints > 1) return 'ios'
  if (/mac/.test(os) || /mac os x/.test(ua)) return 'macos'
  if (/win/.test(os) || /windows/.test(ua)) return 'windows'
  if (/linux|x11/.test(os) || /linux/.test(ua)) return 'linux'

  return 'unknown'
}

export function getRecommendedPlatform(input?: PlatformInput): PlatformDownload | null {
  const platformId = detectPlatform(input)
  return PLATFORM_DOWNLOADS.find((platform) => platform.id === platformId) ?? null
}

export function isPlatformEnabled(platform: PlatformDownload): boolean {
  return platform.availability === 'available' && typeof platform.href === 'string'
}
