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

export const introVideoUrl = 'https://www.youtube.com/watch?v=lcFDDCMZI5s'

// Privacy-enhanced embed: no cookie until the visitor presses play. Autoplay
// only runs because the iframe mounts after the Watch click.
export const introVideoEmbedUrl =
  'https://www.youtube-nocookie.com/embed/lcFDDCMZI5s?rel=0&autoplay=1'
