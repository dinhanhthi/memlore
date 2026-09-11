export const githubUrl = 'https://github.com/dinhanhthi/memlore'

export const meta = {
  title: 'Memlore — Make room for your story',
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
  downloadAria: 'Download the macOS beta from GitHub',
  mainAria: 'Main navigation',
}

export const hero = {
  note: 'An open-source journal, growing with you.',
  titleLead: 'A little life.',
  titleAccent: 'A lasting story.',
  description:
    'For the days you want to remember, and the thoughts you need to put somewhere. A private home for your memories.',
  download: 'Download beta',
  downloadAria: 'Download the macOS beta from GitHub',
  tryDemo: 'Try the demo',
  followGithub: 'Follow the journey',
  availability: 'macOS beta on GitHub. More platforms coming.',
  mascotAlt: 'Memlore’s dog mascot. The head follows your cursor.',
  portraitLead: 'A place to land.',
  portraitAccent: 'Even on the ordinary days.',
}

export const demo = {
  title: 'Get a feel for it.',
  subtitle: 'A real little journal. A made-up life. Yours to explore.',
  cue: 'Click around. It works like the real app.',
  themeAria: 'Choose appearance',
  themes: {
    clay: 'Clay',
    clean: 'Clean',
    signature: 'Signature',
  },
  mobileHintBefore: 'Swipe inside the preview to explore the full app, or',
  mobileHintLink: 'open it separately',
  iframeTitle: 'Interactive Memlore demo with fictional journal entries',
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
  title: 'Even we cannot read it.',
  body: 'Locked with your password, on your Mac. Memlore has no servers and no backdoor.',
  points: [
    'A password is required. Always.',
    'Files on disk stay sealed without it.',
    'Lost password cannot be recovered — not even by us.',
  ],
  figure: {
    words: 'Your words',
    password: 'Your password',
    sealed: 'Sealed',
    unseen: 'Memlore cannot read this',
  },
}

export const locks = {
  title: 'Three locks. Three different silences.',
  body: 'Privacy is not a single switch. Memlore stacks an app lock, a second lock for chosen entries, and an invisible vault that is not there until the right password is spoken.',
  items: [
    {
      id: 'app' as const,
      title: 'App lock',
      text: 'The journal will not open until the password — or Touch ID — lets it. This lock is not optional.',
    },
    {
      id: 'second' as const,
      title: 'Second lock',
      text: 'Chosen entries sit behind an extra password. Unlocking the app is not enough to read them.',
    },
    {
      id: 'invisible' as const,
      title: 'Invisible vault',
      text: 'Separate vaults vanish from lists, search, and calendars until you enter the vault password.',
    },
  ],
}

export const editor = {
  title: 'A quiet page that can still hold a lot.',
  body: 'The editor holds many kinds of input. Convenient to use, and a pleasure to look at.',
  panes: [
    {
      id: 'text' as const,
      title: 'Words',
      sample: 'Tuesday, after the rain. The kitchen still smelled like coffee.',
    },
    {
      id: 'math' as const,
      title: 'Math',
      sample: 'Euler’s identity, written right in the entry.',
    },
    { id: 'code' as const, title: 'Code', sample: 'const day = journal.today()' },
    {
      id: 'media' as const,
      title: 'Media',
      sample: 'Photos, video, and voice memos, kept with the entry.',
    },
  ],
}

export const ai = {
  title: 'AI that stays off until you ask.',
  body: 'Every AI tool is opt-in. Bring a local endpoint, an on-device model, or your own hosted key. Locked and invisible entries stay out of multi-entry features the same way hidden ones do.',
  notice: 'Hosted providers send entry text off-device. Local and on-device paths do not.',
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
      id: 'chat' as const,
      title: 'Daily Chat',
      text: 'A conversation about the day that can become a journal entry when you save it.',
    },
    {
      id: 'ask' as const,
      title: 'Ask Journal',
      text: 'A question over retrieved excerpts from entries you have already indexed. You can even ask about the memories that Memlore has learned.',
    },
    {
      id: 'search' as const,
      title: 'Semantic search',
      text: 'Search by meaning, ranked locally against cached chunk vectors.',
    },
    {
      id: 'emotion' as const,
      title: 'Emotion suggestion',
      text: 'Closest of bad, neutral, or good — from embeddings, not a mood diary of eight faces.',
    },
    {
      id: 'time' as const,
      title: 'Time-machine summary',
      text: 'The same calendar date across years, folded into one recap.',
    },
    {
      id: 'image' as const,
      title: 'Image generation',
      text: 'An in-editor generate action that lands as media you already own.',
    },
    {
      id: 'device' as const,
      title: 'On-device paths',
      text: 'Optional fastembed for embeddings, and an opt-in llama-server sidecar for generation.',
    },
  ],
}

export const chat = {
  title: 'Talk the day through. Keep the page.',
  body: 'Daily Chat is a companion for the hours you would rather speak than type. Replies stream in. The conversation itself is ephemeral. Saving it is a separate, deliberate step — and it becomes an entry in your own words.',
  points: [
    'Off until an AI provider is configured and the privacy notice is accepted.',
    'Stop at any time. Clear wipes the thread. Locking the app wipes it too.',
    'Save as entry drafts a first-person page you can edit before it lands in the journal.',
  ],
}

export const search = {
  title: 'Find the feeling, not the filename.',
  body: 'Look for a word you wrote, or a feeling you only half-remember. Search stays on your Mac.',
  points: [
    'Invisible entries never show up. Locked ones stay out unless you let them in.',
    'Search by meaning is extra, and stays off until you turn it on.',
    'Tags, calendar, On This Day, and maps sit beside it — still offline.',
  ],
}

export const persona = {
  title: 'A second you, in your rhythm.',
  body: 'Optional. It can chat with you, keep a few memories, and write the next line the way you would.',
  points: [
    'Memories are short notes from your journal. You can read and edit them.',
    'Your persona is a second self — how you sound, what you care about.',
    'When it writes for you, it follows that rhythm, not a generic one.',
  ],
  figure: {
    memories: ['the walk after dinner', 'Tuesday kitchen', 'light on the river'],
    reply: 'You always come back to the walk.',
    you: 'That’s my rhythm. Keep going.',
    write: '…the light on the water, the same as last October.',
  },
}

export const locations = {
  title: 'The days, on a map.',
  body: 'Entries and photos can sit where they happened. Open a pin, and you are back on that page.',
  points: [
    'Pins show a picture when the memory has one.',
    'Tap a place to open the entry.',
    'The map lives with the journal, on this Mac.',
  ],
}

export const transfer = {
  title: 'Come with your days. Leave with your files.',
  body: 'Bring a journal from Day One, Journey, Apple Journal, Markdown, or plain text. Export a backup, Markdown, or plain text — all on this Mac.',
  points: [
    'Import Day One JSON, Journey ZIP, an Apple Journal folder, Markdown, or plain text.',
    'Export a Memlore backup, Markdown files, or plain text.',
    'Nothing is sent to us. The files stay with you.',
  ],
  figure: {
    inbound: ['Day One', 'Journey', 'Apple Journal', 'Markdown', 'Plain text'],
    hub: 'Memlore',
    outbound: ['Backup', 'Markdown', 'Plain text'],
  },
}

export const openSource = {
  symbol: 'Made in the open.',
  titleLead: 'Your story is yours.',
  titleAccent: 'So is the choice.',
  body: 'Memlore is open source. You can see how it works, suggest an improvement, or help shape what comes next.',
  beta: 'All current features are free during beta. That is not a promise they stay free after beta. Optional third-party AI providers may charge their own fees.',
  github: 'Meet the project on GitHub',
}

export type ComparisonProductName = 'Memlore' | 'Day One' | 'Journey' | 'Apple Journal'
export type ComparisonMark = 'yes' | 'no' | 'partial'

export type ComparisonProduct = {
  name: ComparisonProductName
  badge?: string
  note: string
  sourceUrl?: string
}

export type ComparisonRow = {
  id: string
  label: string
  marks: Record<ComparisonProductName, ComparisonMark>
}

export const comparison = {
  title: 'Find your kind of journal.',
  intro:
    'Different journals fit different lives. Checks are documented yes. Crosses are documented no. A dash means it varies by plan, or we would have to guess.',
  tableAria: 'Journal comparison table, one column per journal',
  yes: 'Yes',
  no: 'No',
  partial: 'Varies or not documented',
  sourcesLead: 'Explore the details:',
  sourcesNote: 'Features and plans can change.',
  products: [
    {
      name: 'Memlore',
      badge: 'Open source',
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
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'password',
      label: 'Password required before the journal opens',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'local-first',
      label: 'Local-first — no vendor journal server',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'own-cloud',
      label: 'Sync to a cloud folder you already own',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'partial' },
    },
    {
      id: 'extra-locks',
      label: 'Second lock and invisible vault',
      marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
    },
    {
      id: 'optional-ai',
      label: 'Optional AI on your terms',
      marks: { Memlore: 'yes', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'partial' },
    },
    {
      id: 'macos',
      label: 'macOS app',
      marks: { Memlore: 'yes', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
    },
    {
      id: 'ios',
      label: 'iOS app today',
      marks: { Memlore: 'no', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
    },
    {
      id: 'win-linux',
      label: 'Windows or Linux app today',
      marks: { Memlore: 'no', 'Day One': 'partial', Journey: 'yes', 'Apple Journal': 'no' },
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
  titleLead: 'A home on your Mac.',
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
  download: 'Download beta',
  downloadAria: 'Download the macOS beta from GitHub',
  note: 'Made for your life. Made in the open.',
  github: 'GitHub',
}
