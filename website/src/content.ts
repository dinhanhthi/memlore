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
  mainAria: 'Main navigation',
}

export const hero = {
  note: 'An open-source journal, growing with you.',
  titleLead: 'A little life.',
  titleAccent: 'A lasting story.',
  description:
    'For the days you want to remember, and the thoughts you need to put somewhere. A private home for your memories.',
  tryDemo: 'Try the demo',
  followGithub: 'Follow the journey',
  availability: 'Built for macOS. More platforms on the way.',
  mascotAlt: 'Memlore’s friendly golden owl',
  portraitLead: 'A place to land.',
  portraitAccent: 'Even on the ordinary days.',
}

export const demo = {
  title: 'Get a feel for it.',
  subtitle: 'A real little journal. A made-up life. Yours to explore.',
  tag: 'Interactive demo · no account needed',
  tourAria: 'Explore the demo',
  themeLabel: 'Make it yours',
  themeAria: 'Design system for website and demo',
  themes: {
    signature: 'Signature',
    clean: 'Clean',
    clay: 'Clay',
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
  reset: 'Reset demo',
  openSeparately: 'Open separately',
  disclaimer:
    'Everything here is sample data. Writing, locks, sync, and AI replies are simulated; changes reset when you reload.',
  tour: [
    {
      view: 'write' as const,
      label: 'Write a little',
      description: 'Open an entry, try the editor, and make this sample journal your own.',
    },
    {
      view: 'explore' as const,
      label: 'Look back',
      description: 'Browse memories, search for a moment, and explore your writing patterns.',
    },
    {
      view: 'chat' as const,
      label: 'Ask your journal',
      description: 'Ask a question and watch a sample answer arrive, a little at a time.',
    },
    {
      view: 'locks' as const,
      label: 'Keep it private',
      description: 'Explore the different ways to lock entries in this sample journal.',
    },
  ],
}

export const features = {
  titleLead: 'Life is full.',
  titleAccent: 'Keep a little of it.',
  intro:
    'A passing thought. A weekend away. A Tuesday that turned out better than expected. Memlore makes room for all of it.',
  localTitle: 'At home on your device.',
  localText: 'Write offline. Your journal lives locally, with optional sync to your own cloud.',
  items: [
    {
      id: 'writing' as const,
      title: 'More than a blank page.',
      text: 'Write with words, photos, and other media. Give each memory the shape it deserves.',
    },
    {
      id: 'find' as const,
      title: 'Find the moment, not the folder.',
      text: 'Search your entries, follow a tag, open the calendar, or look back on a memory.',
    },
    {
      id: 'locks' as const,
      title: 'Some things are just for you.',
      text: 'Lock the app, add a second lock for chosen entries, or keep an invisible vault hidden until you unlock it.',
    },
    {
      id: 'ai' as const,
      title: 'A fresh way to reflect.',
      text: 'Optional AI can help you ask questions about your journal. It stays off until you choose it.',
    },
    {
      id: 'sync' as const,
      title: 'Your memories can move with you.',
      text: 'Sync through your own cloud, and import or export your journal when you need to.',
    },
    {
      id: 'appearance' as const,
      title: 'See your story taking shape.',
      text: 'Explore your writing over time, and choose an appearance that feels like you.',
    },
  ],
}

export const openSource = {
  symbol: 'Made in the open.',
  titleLead: 'Your story is yours.',
  titleAccent: 'So is the choice.',
  body: 'Memlore is open source. You can see how it works, suggest an improvement, or help shape what comes next.',
  beta: 'All current features are free during beta. That is not a promise they stay free after beta. Optional third-party AI providers may charge their own fees.',
  github: 'Meet the project on GitHub',
}

export type ComparisonProduct = {
  name: string
  badge?: string
  strength: string
  tradeoff: string
  sourceUrl?: string
}

export const comparison = {
  title: 'Find your kind of journal.',
  intro: 'Different journals fit different lives. Here’s the honest trade-off.',
  tableAria: 'Journal comparison table, scroll horizontally on small screens',
  columns: {
    journal: 'Journal',
    strength: 'A good fit if you want…',
    tradeoff: 'Worth knowing',
  },
  sourcesLead: 'Explore the details:',
  sourcesNote: 'Features and plans can change.',
  products: [
    {
      name: 'Memlore',
      badge: 'Open source',
      strength:
        'A local-first journal you can inspect, with extra locks, your own cloud, and optional AI.',
      tradeoff:
        'Still in beta, and macOS-only today. Other platforms are coming, without a date attached.',
    },
    {
      name: 'Day One',
      strength:
        'A polished journaling home with a long-established ecosystem, including encryption and optional AI on some plans.',
      tradeoff: 'Some features need a paid plan. The app is closed source.',
      sourceUrl:
        'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
    },
    {
      name: 'Journey',
      strength:
        'A journal across mobile, desktop, and the web, with encryption and optional AI that vary by plan.',
      tradeoff:
        'Desktop access and many features depend on a paid plan or membership. The app is closed source.',
      sourceUrl:
        'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
    },
    {
      name: 'Apple Journal',
      strength:
        'A simple journal for iPhone, iPad, and Mac, kept close to the rest of Apple’s world.',
      tradeoff:
        'Best inside the Apple ecosystem. Less suited if you want the same journal beyond Apple devices.',
      sourceUrl: 'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
    },
  ] satisfies ComparisonProduct[],
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
  note: 'Made for your life. Made in the open.',
  github: 'GitHub',
}
