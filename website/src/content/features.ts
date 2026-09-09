import type { ReactNode } from 'react'

export interface FeatureGroup {
  eyebrow: string
  title: string
  body: string
  features: string[]
}

export interface Stat {
  value: string
  label: string
}

export interface RoadmapItem {
  title: string
  status: string
  body: string
}

export const heroStats: Stat[] = [
  { value: '100%', label: 'offline-capable' },
  { value: '0', label: 'developer servers' },
  { value: 'AES-256', label: 'encrypted storage' },
]

export const featureGroups: FeatureGroup[] = [
  {
    eyebrow: 'Write',
    title: 'A rich editor that still feels quiet',
    body: 'TipTap powers markdown shortcuts, tables, task lists, code blocks, media embeds, and autosave without turning the journal into a noisy document editor.',
    features: [
      'Markdown shortcuts',
      'Image, video, and audio attachments',
      'Templates and writing prompts',
      'Autosave on every edit',
    ],
  },
  {
    eyebrow: 'Find',
    title: 'Your past stays searchable',
    body: 'SQLite FTS5, semantic search, tags, favorites, calendars, On This Day, maps, and statistics make old entries useful without uploading them to a server.',
    features: [
      'Full-text and semantic search',
      'Tags, favorites, journals, and calendar filters',
      'Media gallery and location map',
      'Writing streaks and mood trends',
    ],
  },
  {
    eyebrow: 'Protect',
    title: 'Privacy is the architecture',
    body: 'Memlore is local-first and zero-knowledge. Password-based encryption, SQLCipher, optional Touch ID, and ciphertext-only sync keep the private parts private.',
    features: [
      'Mandatory password setup',
      'SQLCipher database encryption',
      'Optional Touch ID unlock on macOS',
      'Encrypted Google Drive sync',
    ],
  },
  {
    eyebrow: 'Extend',
    title: 'Helpful AI, only when you opt in',
    body: 'AI features are disabled by default. Use local endpoints for the strongest privacy posture, or bring your own hosted provider key when you choose.',
    features: [
      'Smart title suggestions',
      'Entry highlights and summaries',
      'Go Deeper reflection prompts',
      'Daily Chat and image generation',
    ],
  },
]

export const roadmapItems: RoadmapItem[] = [
  {
    title: 'macOS first',
    status: 'Available first',
    body: 'The reference desktop experience is built and polished on macOS before other platforms ship.',
  },
  {
    title: 'Windows and Linux',
    status: 'Coming soon',
    body: 'Desktop ports land after macOS v1.0 with platform keychains, native installers, and sync verification.',
  },
  {
    title: 'iOS and Android',
    status: 'Coming soon',
    body: 'Mobile builds follow with biometric unlock, mobile storage integrations, and tablet-first layouts.',
  },
]

export const privacyPrinciples: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'No server requirement',
    body: 'Core journaling works offline. Sync is optional, background-only, and uses storage you bring.',
  },
  {
    title: 'No telemetry',
    body: 'No analytics, tracking pixels, session recording, or product metrics collection.',
  },
  {
    title: 'No recovery backdoor',
    body: 'Your password protects the journal key. If it is lost, Memlore cannot reset it or read your entries.',
  },
]
