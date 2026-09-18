# Changelog

Developer-facing release notes. Each `v*` tag's section becomes the body of its
GitHub Release. The plain-language version for users lives on the website's
changelog page.

Versions follow semver, and only changes under `src/`, `src-tauri/`, `public/`,
`index.html`, `vite.config.ts` and `package.json` count toward a bump —
`website/`, `web/`, `workers/`, `docs/` and `e2e/` do not.

## v0.1.1 (2026-09-18)

### Fixed

- **Updates install in the background instead of freezing the app.** The updater
  no longer blocks the UI while downloading; a new `UpdateReadyCard` prompts to
  restart once the install is ready, and release notes render as markdown
  instead of raw text. [#d81b365](https://github.com/dinhanhthi/memlore/commit/d81b365)

### Improved

- **About panel.** Author, website, license and GitHub links are current, and
  the tagline/version layout is tighter.
  [#c114a03](https://github.com/dinhanhthi/memlore/commit/c114a03) [#828290b](https://github.com/dinhanhthi/memlore/commit/828290b)

## v0.1.0 (2026-09-18)

First signed public release. There is no previous version to diff against, so
this section describes what ships rather than what changed.

### Added

- **Signed, notarized macOS builds.** Universal binary (`x86_64` + `arm64`),
  signed with a Developer ID certificate and notarized through App Store
  Connect, published as a `.dmg` from CI on a `v*` tag. Requires macOS 13.
  [#7632d80](https://github.com/dinhanhthi/memlore/commit/7632d80) [#756ff1f](https://github.com/dinhanhthi/memlore/commit/756ff1f)
- **In-app updater** with two channels. `Memlore > Check For Updates…` checks on
  demand; an automatic check runs once per launch and can be turned off in
  Settings → General. The **Beta** channel opts into prereleases. Update
  archives are verified against a minisign public key compiled into the app, so
  a tampered download is rejected rather than installed.
  [#7fce287](https://github.com/dinhanhthi/memlore/commit/7fce287) [#ee8dbd4](https://github.com/dinhanhthi/memlore/commit/ee8dbd4)
- **Touch ID unlock** — the `keychain-access-groups` entitlement and a Developer
  ID provisioning profile are embedded at bundle time, which is what makes
  `BIOMETRY_CURRENT_SET` usable in a distributed build. [#7632d80](https://github.com/dinhanhthi/memlore/commit/7632d80)

### Notes for maintainers

- The updater's minisign keypair **cannot be rotated** after this release: its
  public half is compiled into every shipped binary and Tauri's updater has no
  in-band key rotation. See `.github/release-setup.md`.
- `bundle.createUpdaterArtifacts` is on, so any local `tauri build` needs either
  `TAURI_SIGNING_PRIVATE_KEY` or `--no-sign`. `CONTRIBUTING.md` covers this.
- An expired embedded provisioning profile makes the app unlaunchable for every
  user, not just degraded. `release.yml` refuses to build when under 30 days
  remain, and rejects a Mac Development profile outright.
