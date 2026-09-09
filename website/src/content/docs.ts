export interface DocSection {
  id: string
  title: string
  summary: string
  bullets: string[]
}

export const docSections: DocSection[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    summary: 'Install Memlore, create your password, and start with a private local journal.',
    bullets: [
      'Download the macOS build from the releases page.',
      'Launch the app and set a password with at least eight characters.',
      'Use Cmd+N to create an entry and start writing immediately.',
      'Your entries stay local unless you explicitly configure sync.',
    ],
  },
  {
    id: 'privacy-model',
    title: 'Privacy Model',
    summary: 'Memlore is designed so the developer never sees journal content.',
    bullets: [
      'The database is protected by SQLCipher encryption at rest.',
      'Cloud sync payloads are encrypted before they leave your device.',
      'Touch ID can unlock the local key on supported macOS hardware.',
      'There is no password reset because there is no recovery key server.',
    ],
  },
  {
    id: 'editor',
    title: 'Editor Basics',
    summary: 'The editor supports rich writing without making the page feel busy.',
    bullets: [
      'Use markdown shortcuts for headings, lists, checklists, quotes, code, and dividers.',
      'Attach images, video, and audio notes to entries.',
      'Add mood, location, weather, tags, favorites, and journal metadata from the editor toolbar.',
      'Autosave runs after edits so switching entries does not lose work.',
    ],
  },
  {
    id: 'sync',
    title: 'Sync',
    summary: 'Sync is optional and uses user-owned cloud storage instead of Memlore servers.',
    bullets: [
      'Google Drive sync is available on macOS.',
      'Entry content is stored as mergeable Yjs documents.',
      'Each device writes encrypted sync data and merges updates in the background.',
      'Media attachments are encrypted before upload and cached locally when opened.',
    ],
  },
  {
    id: 'import-export',
    title: 'Import and Export',
    summary: 'Your data remains portable.',
    bullets: [
      'Export to Memlore JSON ZIP, Markdown, and plain text.',
      'Import Memlore backups, Day One JSON ZIP, Journey ZIP, Markdown folders, and text folders.',
      'PDF export is deferred until the cross-platform phase.',
      'Imports reuse the encrypted local database path after unlock.',
    ],
  },
  {
    id: 'ai',
    title: 'AI Privacy',
    summary: 'AI is opt-in and provider-controlled.',
    bullets: [
      'All AI features are off by default.',
      'Local endpoints such as Ollama or LM Studio keep requests on your machine.',
      'Hosted providers require explicit consent because entry text may leave the device.',
      'Audit and usage surfaces record metadata, not journal content.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Common issues and what to check first.',
    bullets: [
      'If unlock fails, verify the password. Memlore cannot recover forgotten passwords.',
      'If sync stalls, confirm the app is unlocked and the Google Drive connection is still valid.',
      'If media is missing on another device, open the attachment to trigger encrypted download and cache.',
      'If AI features do nothing, verify a provider is configured and the specific feature toggle is enabled.',
    ],
  },
]
