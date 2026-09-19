export const githubUrl = 'https://github.com/dinhanhthi/memlore'

export const licenseUrl = `${githubUrl}?tab=AGPL-3.0-1-ov-file`

// The Download button points here, not straight at the .dmg: the Worker at
// dl.memlore.app records the download (time, version, Cloudflare-inferred
// country — never an IP, never a cookie) and then redirects to the GitHub
// asset. If it cannot resolve the current version it falls back to the
// Releases page, so the button degrades rather than dies. See workers/stats/.
export const downloadUrl = 'https://dl.memlore.app/mac'
