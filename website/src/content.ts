export const githubUrl = 'https://github.com/dinhanhthi/memlore'
export const authorUrl = 'https://dinhanhthi.com'
export const contactEmail = 'me@dinhanhthi.com'

export const meta = {
  title: 'Memlore — A little life. A lasting story.',
  description:
    'A private place for your memories. Explore Memlore, an open-source journal for writing, reflecting, and finding your way back to what matters.',
}

export const nav = {
  skip: 'Skip to content',
  homeAria: 'Memlore home',
  wordmark: 'Memlore',
  demo: 'Demo',
  features: 'Features',
  compare: 'Compare',
  doc: 'Doc',
  docDisclosure: 'Documentation is coming soon. For now, explore the',
  docReadme: 'GitHub README',
  github: 'GitHub',
  download: 'Download',
  downloadAria: 'Download the beta from GitHub',
  mainAria: 'Main navigation',
  menu: 'Open menu',
  closeMenu: 'Close menu',
}

export const hero = {
  badgeOpenSource: 'Open source',
  badgeFree: 'Free',
  titleLead: 'A little life.',
  titleAccent: 'A lasting story.',
  descriptionLead: 'Memlore is a private journal.',
  description: 'For the days you want to remember, and the thoughts you need to put somewhere.',
  download: 'Download for Mac',
  downloadAria: 'Download the beta from GitHub',
  tryDemo: 'Try the demo',
  followGithub: 'Follow the journey',
  availability: 'More platforms coming.',
  mascotAlt: 'Memlore’s dog mascot. The head follows your cursor.',
  mascotAltStill: 'Memlore’s dog mascot.',
  portraitLead: 'A place to land.',
  portraitAccent: 'Even on the ordinary days.',
}

export const demo = {
  title: 'Get a feel for it.',
  subtitle: 'A mockup of the Memlore app with fake data.',
  cue: 'Click around. It works like the real app.',
  themeAria: 'Choose appearance',
  themes: {
    clay: 'Clay',
    clean: 'Clean',
    signature: 'Signature',
  },
  placeholderTitle: 'This preview needs a wider window.',
  placeholderBody:
    'The live journal is a desktop app, so it cannot run here. When the iOS and Android apps arrive, their view will take this place.',
  iframeTitle: 'Interactive Memlore demo with fictional journal entries',
  posterAlt: 'Blurred preview of the Memlore journal with a sample entry open',
  start: 'Start the demo',
  loadingTitle: 'Opening your sample journal…',
  loadingText: 'There are a few memories to unpack.',
  errorTitle: 'The demo is taking a little longer.',
  errorText: 'Try loading it again, or open the demo in its own tab.',
  tryAgain: 'Try again',
  openDemo: 'Open demo',
  openSeparately: 'Open separately',
  disclaimer: 'Sample data. Writing, locks, sync, and AI are simulated.',
}

export const encrypt = {
  title: 'No server. No backdoor. We cannot read it.',
  body: 'Everything is encrypted on your device with your password — including what syncs to your own cloud. There is no Memlore server in between, and no way back in without that password.',
  figure: {
    content: 'Your content',
    cloud: 'Your cloud',
    others: 'Others (even us)',
    password: 'Your password',
    blocked: 'No access',
    unseen: 'Encrypted before it leaves your device',
  },
}

export const sync = {
  title: 'Your cloud. Your account. Your key.',
  body: 'Entries are encrypted on your device, then synced through your own Google Drive or iCloud Drive. We never hold your files, your account, or your key.',
  // Marks drawn in the cloud card, in order. `more` is the dashed placeholder
  // standing in for the cloud services still to come.
  // TODO(later): only gdrive and icloud ship today — see docs/LATER.md.
  providers: ['gdrive', 'icloud', 'more'] as const,
  figure: {
    device: 'This device',
    otherDevice: 'Your other devices',
    encrypted: 'Encrypted with your password',
    synced: 'Synced',
    cloud: 'Your own cloud',
    noServer: 'No Memlore server in between',
  },
}

export const locks = {
  title: 'You can lock entries in 3 different ways.',
  items: [
    {
      id: 'app' as const,
      title: 'App lock',
      text: 'The journal only opens with the password or Touch ID. This lock is required and protects it from unauthorized access.',
    },
    {
      id: 'second' as const,
      title: 'Second lock',
      text: 'To keep some entries private, add a second lock. Others with app access will know private entries exist, but cannot open them.',
    },
    {
      id: 'invisible' as const,
      title: 'Invisible vault',
      text: 'If you need entries to stay completely invisible and private, even from people who can unlock the app, they won’t know these entries exist.',
    },
  ],
}

export const editor = {
  title: 'Feature-rich editor',
  body: 'The Editor fully supports Markdown, math, code, media, @-mentions, and optional plugins. It responds quickly, even with very long content.',
  slashItems: [
    { label: 'Heading 1', hint: '#' },
    { label: 'Image' },
    { label: 'Today' },
  ] satisfies { label: string; hint?: string }[],
  markdownSample: '**Tuesday**\n- [x] coffee\n- [ ] the walk',
  panes: [
    {
      id: 'text' as const,
      title: 'Words',
      sample: 'Tuesday, after the rain. The kitchen still smelled like coffee.',
    },
    {
      id: 'math' as const,
      title: 'Math',
      sample: "Euler's identity, written right in the entry.",
    },
    { id: 'code' as const, title: 'Code', sample: 'const day = journal.today()' },
    {
      id: 'media' as const,
      title: 'Media',
      sample: 'Photos, video, and voice memos, kept with the entry.',
    },
    {
      id: 'slash' as const,
      title: 'Slash command',
      sample: "Type / for a heading, image, or today's date.",
    },
    {
      id: 'mention' as const,
      title: 'Mentions',
      sample: 'Type @ to link another entry by its title.',
    },
    {
      id: 'markdown' as const,
      title: 'Markdown',
      tag: 'GFM',
      sample: 'GitHub Flavored Markdown. Type it, paste it, keep it.',
    },
    {
      id: 'plugins' as const,
      title: 'More plugins later',
      sample: 'The page can grow. More editor plugins can land without changing how you write.',
    },
  ],
}

export const ai = {
  title: 'Rich set of AI features',
  body: 'AI tools are enabled only if you opt in. Memlore supports 100% local AI, as well as hosted providers using your own key.',
  items: [
    {
      id: 'titles' as const,
      title: 'Smart titles',
      text: 'A short title suggestion from the entry you just wrote.',
    },
    {
      id: 'summaries' as const,
      title: 'Highlights and summaries',
      text: 'A collapsible recap of themes, emotions, and moments, saved with the entry.',
    },
    {
      id: 'deeper' as const,
      title: 'Go Deeper',
      text: 'Three follow-up reflection prompts, inserted as cards under the editor.',
    },
    {
      id: 'continue' as const,
      title: 'Continue & Rewrite',
      text: 'Continue the entry from the footer, or rewrite a selection — in your voice.',
    },
    {
      id: 'chat' as const,
      title: 'Daily Chat',
      text: 'A conversation about the day that can become a journal entry when you save it.',
    },
    {
      id: 'ask' as const,
      title: 'Ask Journal',
      text: 'You can ask about the memories and entries that Memlore has learned.',
    },
    {
      id: 'memories' as const,
      title: 'Memories and Persona',
      text: 'Based on your entries and information you provide, Memlore can build a second you that writes in your voice and style.',
    },
    {
      id: 'reviews' as const,
      title: 'Reviews and Insights',
      text: 'You can use AI to get the stats of what you have written in a given time period.',
    },
    {
      id: 'search' as const,
      title: 'Semantic search',
      text: 'Not just a keyword search, but a meaning-based search, freely expressed in natural language.',
    },
    {
      id: 'emotion' as const,
      title: 'Emotion suggestion',
      text: "If you enable the emotion tracking feature, AI can suggest the emotions you're feeling based on the entries you've written.",
    },
    {
      id: 'time' as const,
      title: 'Time-machine summary',
      text: 'The same calendar date across years, folded into one recap.',
    },
    {
      id: 'image' as const,
      title: 'Image generation',
      text: 'Using AI to generate cover images and inline illustrations for your entries.',
    },
    {
      id: 'device' as const,
      title: 'On-device paths',
      text: 'Memlore comes with integrated, local AI to ensure your data is always 100% private and never leaves your device.',
    },
  ],
}

export const emotions = {
  title: 'Emotion tracking',
  body: 'Your mood can be tracked and analyzed over time.',
  figure: {
    prompt: 'How are you feeling?',
    options: [
      { key: 'bad' as const, emoji: '\u{1F61E}', label: 'Not good' },
      { key: 'neutral' as const, emoji: '\u{1F610}', label: 'So-so' },
      { key: 'good' as const, emoji: '\u{1F60A}', label: 'Good' },
    ],
    selected: 'good' as const,
    trend: 'Emotion trend',
    // One mark per day of a sample stretch, oldest first.
    marks: [
      'neutral',
      'bad',
      'neutral',
      'good',
      'good',
      'neutral',
      'good',
      'bad',
      'neutral',
      'good',
      'good',
      'good',
    ] as const,
  },
}

export const chat = {
  title: 'Daily Chat',
  body: "If you're unsure what to write, chat with your Memlore buddy about your day or anything on your mind. Memlore can help synthesize your thoughts into a complete entry, and you can customize your buddy's persona.",
  figure: {
    title: 'Daily Chat',
    save: 'Save as entry',
    placeholder: 'Tell me about your day…',
    messages: [
      { from: 'you' as const, text: 'Long day. Walked to the river after dinner.' },
      {
        from: 'ai' as const,
        text: 'That walk keeps coming up. What stayed with you tonight?',
      },
      { from: 'you' as const, text: 'I left the headphones at home. It was quiet.' },
    ],
  },
}

export const search = {
  title: 'Search your journal',
  body: 'Find a word you wrote, or something you only half-remember. Search stays on your device, next to tags, calendar, and maps.',
}

export const persona = {
  title: 'Memories and persona',
  body: 'Memlore distills memories from your entries. Opt in, and it builds a second you that writes in your voice and style.',
  figure: {
    fromEntries: 'From your entries',
    memories: ['the walk after dinner', 'Tuesday kitchen', 'light on the river'],
    reply: 'A second you, in your voice.',
    write: '…the light on the water, the same as last October.',
  },
}

export const locations = {
  title: 'Entries on a map',
  body: 'Entries and photos sit where they happened. Open a pin to go back to that page.',
}

export const transfer = {
  title: 'Import and export',
  body: 'You can import entries (including media) from other platforms into Memlore, and vice versa. Make sure the migration is seamless.',
  figure: {
    inbound: ['Day One', 'Journey', 'Apple Journal', 'Markdown', 'Plain text'],
    hub: 'Memlore',
    outbound: ['Backup', 'Markdown', 'Plain text'],
  },
}

export const openSource = {
  symbol: 'Made in the open.',
  title: 'Open source',
  body: 'Open so you can see how a journal is secured and how your data is kept. Memlore stays free. Beta is only for extras that keep the project going.',
  github: 'View on GitHub',
}

export type ComparisonProductName = 'Memlore' | 'Day One' | 'Journey' | 'Apple Journal'
export type ComparisonLevel = 1 | 2 | 3 | 4
export type ComparisonMark = 'yes' | 'no' | 'partial' | 'soon' | ComparisonLevel

export type ComparisonProduct = {
  name: ComparisonProductName
  note: string
  sourceUrl?: string
}

export type ComparisonRow = {
  id: string
  label: string
  description?: string
  marks: Record<ComparisonProductName, ComparisonMark>
}

export const comparison = {
  title: 'How Memlore compares.',
  intro: 'Memlore next to three journals people already keep.',
  tableAria: 'Journal comparison table, one column per journal',
  yes: 'Yes',
  no: 'No',
  partial: 'Varies or not documented',
  soon: 'Soon',
  levels: ['A few', 'About half', 'Most', 'The full set'],
  sourcesLead: 'Explore the details:',
  sourcesNote: 'Features and plans can change.',
  products: [
    {
      name: 'Memlore',
      note: 'Still in beta, and macOS-only today. Other platforms are coming, without a date attached.',
    },
    {
      name: 'Day One',
      note: 'A polished journaling home with a long-established ecosystem. Some features need a paid plan. The app is closed source.',
      sourceUrl:
        'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
    },
    {
      name: 'Journey',
      note: 'A journal across mobile, desktop, and the web. Desktop access and many features depend on a paid plan. The app is closed source.',
      sourceUrl:
        'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
    },
    {
      name: 'Apple Journal',
      note: 'A simple journal for iPhone, iPad, and Mac, kept close to the rest of Apple’s world.',
      sourceUrl: 'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
    },
  ] satisfies ComparisonProduct[],
  rows: [
    {
      id: 'open-source',
      label: 'Open source',
      description: 'Anyone can read the code that holds the journal.',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'password',
      label: 'Password required before the journal opens',
      description: 'Not a setting you can switch off. Without it the files stay sealed.',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'your-key-only',
      label: 'Held by your password alone',
      description:
        'All four encrypt. Only Memlore asks for no account, keeps no vendor server, and holds no recovery path back into your journal.',
      marks: {
        Memlore: 'yes',
        'Day One': 'partial',
        Journey: 'partial',
        'Apple Journal': 'partial',
      },
    },
    {
      id: 'local-first',
      label: 'Local-first — no vendor journal server',
      description: 'The journal lives on your machine and works with the network off.',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'own-cloud',
      label: 'Sync through a cloud folder you already own',
      description:
        'Memlore uses your Google Drive or iCloud Drive. Journey offers Google Drive too.',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'yes', 'Apple Journal': 'partial' },
    },
    {
      id: 'extra-locks',
      label: 'Second lock and invisible vault',
      description: 'Some entries stay shut, and some leave no trace that they exist.',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'optional-ai',
      label: 'How much optional AI you get',
      description:
        'Titles, summaries, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, memories, persona, reviews, insights, semantic search, emotion, time-machine, images — local, on-device, or your own key.',
      marks: { Memlore: 4, 'Day One': 2, Journey: 1, 'Apple Journal': 'no' },
    },
    {
      id: 'editor',
      label: 'An editor that holds more than text',
      description: 'Markdown, math, code blocks, slash commands, and media inside the page.',
      marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
    },
    {
      id: 'appearance',
      label: 'Make it look like yours',
      description: 'Three design systems, each in light and dark, plus a swappable writing font.',
      marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
    },
    {
      id: 'macos',
      label: 'macOS app',
      marks: { Memlore: 'yes', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
    },
    {
      id: 'ios',
      label: 'iOS and Android app',
      marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'partial' },
    },
    {
      id: 'win-linux',
      label: 'Windows or Linux app',
      marks: { Memlore: 'soon', 'Day One': 'partial', Journey: 'yes', 'Apple Journal': 'no' },
    },
    {
      id: 'beta-free',
      label: 'All current features free during beta',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'partial' },
    },
  ] satisfies ComparisonRow[],
}

export type PlatformName = 'macOS' | 'Windows & Linux' | 'iOS & Android'

export const platforms = {
  titleLead: 'A home on your devices.',
  titleAccent: 'More doors opening soon.',
  intro:
    'We’re starting with macOS and taking the time to make it feel right. Follow along as Memlore grows.',
  items: [
    { name: 'macOS' as const, status: 'In development · beta' },
    { name: 'Windows & Linux' as const, status: 'Coming soon' },
    { name: 'iOS & Android' as const, status: 'Coming soon' },
  ] satisfies { name: PlatformName; status: string }[],
}

export const footer = {
  titleLead: 'The ordinary days',
  titleAccent: 'are worth keeping.',
  tryDemo: 'Try the demo',
  download: 'Download for Mac',
  downloadAria: 'Download the beta from GitHub',
  note: 'Made with ❤️ by',
  author: 'Thi',
  github: 'GitHub',
}

export type LegalSection = {
  id: string
  heading: string
  paragraphs: string[]
  bullets?: string[]
}

export const legal = {
  updatedLabel: 'Last updated',
  updated: '17 September 2026',
  privacyLink: 'Privacy',
  termsLink: 'Terms',
  homeAria: 'Memlore home',
}

export const privacy = {
  title: 'Memlore — Privacy Policy',
  description:
    'How Memlore treats your journal: it stays on your device, with no Memlore server, no telemetry, and optional cloud and AI that you control.',
  heading: 'Privacy Policy',
  intro:
    'Memlore is a private journal. This page explains what the app and this website do with information — and what they never do.',
  googleUserDataPolicyUrl: 'https://developers.google.com/terms/api-services-user-data-policy',
  sections: [
    {
      id: 'whoWeAre',
      heading: 'Who we are',
      paragraphs: [
        'Memlore is made by Anh-Thi Dinh. It is an open-source journal app.',
        `Questions: ${contactEmail}.`,
      ],
    },
    {
      id: 'whatWeDoNotCollect',
      heading: 'What we do not collect',
      paragraphs: [
        'There is no Memlore server and no Memlore account. The app does not watch you.',
      ],
      bullets: ['No telemetry', 'No analytics', 'No advertising', 'No tracking pixels'],
    },
    {
      id: 'onYourDevice',
      heading: 'Your journal on your device',
      paragraphs: [
        'Your journal lives on your device, in an encrypted local database. We cannot read it.',
      ],
    },
    {
      id: 'googleDrive',
      heading: 'Optional Google Drive sync',
      paragraphs: [
        'If you sync, you connect your own Google account. Memlore asks only for the drive.appdata scope: https://www.googleapis.com/auth/drive.appdata.',
        'Synced files sit in Google Drive’s hidden Application Data folder. They are not visible in drive.google.com.',
        'Entries, media, and settings are encrypted on your device before they are uploaded. A small sync list and device registry — IDs, timestamps, deletion flags, and your device name, not journal text — are stored as JSON in the hidden Application Data folder. Memlore cannot read your other Drive files.',
        'The refresh token is stored only in the encrypted database on your device. The access token stays in memory and is never written to disk.',
      ],
    },
    {
      id: 'googleLimitedUse',
      heading: 'Google API Limited Use',
      paragraphs: [
        "Memlore's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
      ],
    },
    {
      id: 'googleUserData',
      heading: 'How Google user data is used',
      paragraphs: [
        'Google user data is not sold, not used for ads, and not transferred to third parties except as needed to operate Drive sync in your own account.',
        'Memlore reads your Google account email, and your Drive storage quota, so the app can show which account is connected. Both stay only in the encrypted database on your device. They are not sent to a Memlore server. Disconnecting clears them.',
        'You can disconnect in the app. You can also disconnect in Google Drive → Settings → Manage apps.',
      ],
    },
    {
      id: 'icloudDrive',
      heading: 'Optional iCloud Drive',
      paragraphs: [
        'iCloud Drive is the same idea: your own cloud, files encrypted on your device before they leave. This is not Google data.',
      ],
    },
    {
      id: 'optionalAi',
      heading: 'Optional AI',
      paragraphs: [
        'AI stays off until you opt in and accept a privacy notice. You choose the provider — local or on-device, or a hosted one.',
        'Hosted providers receive the entry text you send them. That is not a transfer of Google API data. Memlore does not operate those AI services.',
      ],
    },
    {
      id: 'mapsAndSpeech',
      heading: 'Optional maps, places, and speech',
      paragraphs: [
        'Maps, geocoding, and speech-to-text run only if you turn them on. They talk to the provider you choose — for example Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit, or your speech-to-text provider.',
      ],
    },
    {
      id: 'appUpdates',
      heading: 'App updates',
      paragraphs: [
        'The app may request GitHub release metadata so it can tell you when an update is available. That check is not telemetry.',
      ],
    },
    {
      id: 'thisWebsite',
      heading: 'This website',
      paragraphs: [
        'This marketing website does not set analytics cookies and does not collect journal data. The interactive demo uses sample data only.',
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      paragraphs: ['Memlore is not directed at children under 13.'],
    },
    {
      id: 'changes',
      heading: 'Changes',
      paragraphs: [
        'This policy may change. The date at the top of the page shows when it was last updated.',
      ],
    },
    {
      id: 'contact',
      heading: 'How to reach us',
      paragraphs: [`Privacy questions: ${contactEmail}.`],
    },
  ] satisfies LegalSection[],
}

export const terms = {
  title: 'Memlore — Terms of Service',
  description:
    'The terms for using Memlore: an AGPL-licensed journal still in development, with your writing remaining yours.',
  heading: 'Terms of Service',
  intro:
    'These terms cover the Memlore app and this website. If you do not agree, please do not use them.',
  sections: [
    {
      id: 'license',
      heading: 'The software and your journal',
      paragraphs: [
        'The Memlore software is licensed under AGPL-3.0-or-later. Your journal belongs to you. Using the app does not relicense what you write.',
      ],
    },
    {
      id: 'inDevelopment',
      heading: 'Still in development',
      paragraphs: [
        'Memlore is in development. Today’s build is a macOS beta. Features and file formats may change.',
      ],
    },
    {
      id: 'yourData',
      heading: 'Your data, your keys',
      paragraphs: [
        'You own your journal. You are responsible for your password, your 24-word recovery phrase, and your backups.',
        'If you lose the recovery phrase and lose your devices, the journal cannot be recovered. That is by design.',
      ],
    },
    {
      id: 'thirdParties',
      heading: 'Optional third-party services',
      paragraphs: [
        'Optional services — Google, Apple, AI providers, and map, geocoding, or speech-to-text providers — have their own terms. Memlore is not those services.',
      ],
    },
    {
      id: 'acceptableUse',
      heading: 'Acceptable use',
      paragraphs: [
        'Do not use Memlore for unlawful purposes. Do not try to break the encryption of someone else’s data.',
      ],
    },
    {
      id: 'noWarranty',
      heading: 'No warranty',
      paragraphs: ['Memlore is provided "as is", without warranty of any kind.'],
    },
    {
      id: 'liability',
      heading: 'Limitation of liability',
      paragraphs: [
        'To the extent permitted by law, Memlore and its author are not liable for lost data, lost access, or other damages arising from use of the app.',
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      paragraphs: [`Questions about these terms: ${contactEmail}.`],
    },
  ] satisfies LegalSection[],
}
