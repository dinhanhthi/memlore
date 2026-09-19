/** Empty-root marker the Vite plugin replaces with the crawler twin. */
export const ROOT_MARKER = '<div id="root"></div>'

const LOGO_SRC = './logo-without-container/256.png'

const PAPER_LIGHT = 'oklch(0.995 0.003 55)'
const PAPER_DARK = 'oklch(0.145 0.004 55)'
const INK_LIGHT = 'oklch(0.145 0.004 55)'
const INK_DARK = 'oklch(0.985 0.002 55)'

/**
 * Inline first-paint splash. CSS is a JS import, so this style has to ship
 * in the HTML shell or JS users see the classless crawler twin.
 */
export function renderBootStyle(): string {
  return `<style id="site-boot-style">
html:not(.site-ready),
html:not(.site-ready) body {
  background: ${PAPER_LIGHT};
}
html:not(.site-ready) #root {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.site-boot {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${PAPER_LIGHT};
  color: ${INK_LIGHT};
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.site-boot-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  animation: site-boot-breathe 2.8s ease-in-out infinite;
}
.site-boot-brand img {
  display: block;
  width: 2.75rem;
  height: 2.75rem;
}
.site-boot-brand span {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
@keyframes site-boot-breathe {
  50% { opacity: 0.72; }
}
@media (prefers-color-scheme: dark) {
  html:not(.site-ready),
  html:not(.site-ready) body,
  .site-boot {
    background: ${PAPER_DARK};
    color: ${INK_DARK};
  }
}
@media (prefers-reduced-motion: reduce) {
  .site-boot-brand {
    animation: none;
  }
}
html.site-ready .site-boot {
  display: none;
}
</style>`
}

export function renderBootSplash(): string {
  return `<div class="site-boot" aria-hidden="true"><div class="site-boot-brand"><img src="${LOGO_SRC}" alt="" width="44" height="44" /><span>Memlore</span></div></div>`
}

export function renderBootNoscript(): string {
  return `<noscript><style>
html:not(.site-ready) #root {
  position: static;
  width: auto;
  height: auto;
  padding: 0;
  margin: 0;
  overflow: visible;
  clip: auto;
  clip-path: none;
  white-space: normal;
}
.site-boot {
  display: none !important;
}
</style></noscript>`
}

export function injectBootShell(html: string): string {
  if (!html.includes('</head>')) {
    throw new Error('boot shell: </head> not found')
  }
  if (!html.includes(ROOT_MARKER)) {
    throw new Error(`boot shell: ${ROOT_MARKER} not found`)
  }
  return html
    .replace('</head>', () => `${renderBootStyle()}</head>`)
    .replace(ROOT_MARKER, () => `${renderBootSplash()}${renderBootNoscript()}${ROOT_MARKER}`)
}

const MARKETING_SHELL = /(?:^|\/)(index|about|privacy|terms|changelog)\.html$/

/** Inject the splash, then (optionally) the crawler twin — splash stays a sibling of #root. */
export function applyMarketingShell(html: string, path: string, article?: string): string {
  if (!MARKETING_SHELL.test(path)) return html
  const withBoot = injectBootShell(html)
  if (!article) return withBoot
  if (!withBoot.includes(ROOT_MARKER)) {
    throw new Error(`prerender-static-shells: ${ROOT_MARKER} not found in ${path}`)
  }
  return withBoot.replace(ROOT_MARKER, () => `<div id="root">${article}</div>`)
}
