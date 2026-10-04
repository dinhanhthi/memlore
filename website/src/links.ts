export const githubUrl = 'https://github.com/dinhanhthi/memlore'

export const licenseUrl = `${githubUrl}?tab=AGPL-3.0-1-ov-file`

export const editorFeatureRequestUrl = `${githubUrl}/issues/new?title=${encodeURIComponent('Editor feature request: ')}&labels=enhancement`

export const aiFeatureRequestUrl = `${githubUrl}/issues/new?title=${encodeURIComponent('AI feature request: ')}&labels=enhancement`

// The Download button points here, not straight at the .dmg: the Worker at
// dl.memlore.app records the download (time, version, Cloudflare-inferred
// country — never an IP, never a cookie) and then redirects to the GitHub
// asset. If it cannot resolve the current version it falls back to the
// Releases page, so the button degrades rather than dies. See workers/stats/.
export const downloadUrl = 'https://dl.memlore.app/mac'

export const introVideoUrl = 'https://youtu.be/Mv3LZ_P5lwg'

// Privacy-enhanced embed: no cookie until the visitor presses play. Autoplay
// only runs because the iframe mounts after the Watch click.
export const introVideoEmbedUrl =
  'https://www.youtube-nocookie.com/embed/Mv3LZ_P5lwg?rel=0&autoplay=1'

export const webAppUrl = 'https://web.memlore.app'

// Launch flag: deploy-website.yml deploys memlore.app automatically on every push to main.
// This flag MUST stay false until the web companion has been deployed to Cloudflare Pages
// and the read-only smoke test passes (setup-guide.md §5). While false, the marketing site
// displays "Coming soon" without active links to web.memlore.app.
export const webAppLive = true
