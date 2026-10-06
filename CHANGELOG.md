# Changelog

Developer-facing release notes for both platforms. `## v…` sections are the
desktop app; each one becomes the body of its GitHub Release. `## web-v…`
sections are the web companion (web.memlore.app), which has its own versions and
no GitHub Release. The plain-language version for users lives on the website's
changelog page.

Versions follow semver, per platform. Desktop bumps count changes under `src/`,
`src-tauri/`, `public/`, `index.html`, `vite.config.ts` and `package.json`; web
bumps count `web/`, `workers/web-auth/`, `src/`, `public/`, the `memlore-core`
and `memlore-wasm` crates and `package.json`. `website/`, `mockup/`, `docs/` and
`e2e/` count for neither.

## v0.2.2 (2026-10-06)

### Added

- **Repair sync from this device.** The recovery wizard can publish entries and
  journals that live on this Mac and that no other device owns, including
  journals that never had an owner, so they upload on the next sync. Nothing is
  deleted on this device or in the cloud.
  [#6ce1249](https://github.com/dinhanhthi/memlore/commit/6ce1249)
  [#4710b94](https://github.com/dinhanhthi/memlore/commit/4710b94)
- **Desktop imports edits made in Memlore Web.** Sync discovers the companion's
  sealed outbox and merges those edits and new entries into the local journal.
  The desktop copy wins conflicts. An intent this Mac has already refused is
  not imported again on every cycle.
  [#7b0d1cf](https://github.com/dinhanhthi/memlore/commit/7b0d1cf)
  [#45a44c8](https://github.com/dinhanhthi/memlore/commit/45a44c8)
  [#2a6b9e3](https://github.com/dinhanhthi/memlore/commit/2a6b9e3)

### Improved

- **Home AI cards.** Insights and related list cards use an orb loader and a
  tighter list, with padding around a hovered row.
  [#829673d](https://github.com/dinhanhthi/memlore/commit/829673d)
  [#bcd0768](https://github.com/dinhanhthi/memlore/commit/bcd0768)

### Notes for maintainers

- Envelope crypto and payload framing live in `memlore-core`, with
  `memlore-wasm` bindings for the web companion. An outbox seal rejects an
  oversized input.
  [#5ade521](https://github.com/dinhanhthi/memlore/commit/5ade521)
  [#de7f962](https://github.com/dinhanhthi/memlore/commit/de7f962)
  [#d2e0c29](https://github.com/dinhanhthi/memlore/commit/d2e0c29)
  [#59a20e8](https://github.com/dinhanhthi/memlore/commit/59a20e8)
  [#a619b7c](https://github.com/dinhanhthi/memlore/commit/a619b7c)

## web-v0.1.1 (2026-10-06)

### Added

- **Google account in Sync settings.** Shows the signed-in Drive email and how
  much storage is free.
  [#d6e55b2](https://github.com/dinhanhthi/memlore/commit/d6e55b2)

### Improved

- **Faster open and refresh.** A cached entry list shows immediately while
  Drive revalidates, per-device reads run in parallel, and folder ids are
  remembered so the first refresh lists less.
  [#b29ed43](https://github.com/dinhanhthi/memlore/commit/b29ed43)
  [#2f5bd04](https://github.com/dinhanhthi/memlore/commit/2f5bd04)
  [#ff117d1](https://github.com/dinhanhthi/memlore/commit/ff117d1)
- **Memlore Web explains itself.** The header uses that name, pages the browser
  cannot do show a short placeholder, and About lists what the companion can
  and cannot do. A password-mode mismatch tells you to fix it on the desktop
  app.
  [#0755ac8](https://github.com/dinhanhthi/memlore/commit/0755ac8)
  [#3539b37](https://github.com/dinhanhthi/memlore/commit/3539b37)
  [#0b0bbdb](https://github.com/dinhanhthi/memlore/commit/0b0bbdb)
  [#92fe0fd](https://github.com/dinhanhthi/memlore/commit/92fe0fd)

### Fixed

- **The editor stays read-only when web writes are off.**
  [#1bfaf24](https://github.com/dinhanhthi/memlore/commit/1bfaf24)
- **Entry cards no longer offer delete.**
  [#f001458](https://github.com/dinhanhthi/memlore/commit/f001458)
- **Google sign-in no longer opens a second page** after the Drive popup.
  [#f6bf265](https://github.com/dinhanhthi/memlore/commit/f6bf265)
  [#9e8d49d](https://github.com/dinhanhthi/memlore/commit/9e8d49d)

## web-v0.1.0 (2026-10-05)

First release of the web companion at web.memlore.app. It opens an existing
desktop vault in the browser; creating a vault stays on the desktop.

### Added

- **Open your vault in the browser.** Sign in with Google, enter the 24-word
  recovery phrase, and choose a web password. The browser registers as its own
  device, which desktop can remove from Settings → Security. Keys live in
  WebAssembly memory; IndexedDB holds only ciphertext.
- **Lazy reads from Google Drive.** The five newest entries load first, older
  ones on demand, and media when an entry is opened. A media cache keeps
  ciphertext only and cleans itself up.
- **Edits through an outbox.** The web never writes sync files. Edits
  (content, title, date, emotion, favorite, journal, tags, photos and videos)
  are sealed into the browser's own `outbox/` folder, and the desktop imports and
  merges them with its own sync code. Desktop wins conflicts, and nothing is ever
  deleted from the web. Writes are behind the `WEB_WRITES_ENABLED` switch and
  start off.
- **Desktop outbox importer.** Desktop sync discovers and imports those outbox
  edits and creations, merging Yjs documents without clock comparisons, and
  publishes its decisions so the web stops re-sending them.
- **Safety checks before every write.** The recovery fence, an unknown-format
  latch that turns the web read-only, a clock-skew limit, and seal-then-verify of
  every payload.
- **Pending edits from other browsers** show in the overlay, read-only, before
  desktop imports them.

### Notes for maintainers

- Version in `web/version.json`; tags are `web-v*` and deploy through
  `deploy-web.yml`. No GitHub Release is created for a web tag.
- The OAuth Worker (`workers/web-auth`) only exchanges the Google code.
  There is no Memlore data server.

## v0.2.1 (2026-10-01)

### Added

- **Story numbers on Statistics and the home dashboard.** The Charts tab opens
  with six tiles for the selected period: entries, words, day streak, mood
  split, days written this year, and the hour you write most, each with a small
  chart. Home cards use the same charts and tone chips, with more padding and
  an icon beside each title.
  [#d9a1b33](https://github.com/dinhanhthi/memlore/commit/d9a1b33)
  [#6e0c7ab](https://github.com/dinhanhthi/memlore/commit/6e0c7ab)
  [#3eec79f](https://github.com/dinhanhthi/memlore/commit/3eec79f)
  [#a59815b](https://github.com/dinhanhthi/memlore/commit/a59815b)
  [#1e6c8bf](https://github.com/dinhanhthi/memlore/commit/1e6c8bf)
- **Desktop outbox importer for companion web writes.** Desktop sync cycles
  automatically discover and import encrypted outbox edits and creations from
  companion devices, merging Yjs entry documents and field changes without clock skew.

### Notes for maintainers

- Dev Cargo builds stay smaller; `scripts/tauri.sh` keeps the release bundle
  profile in-repo.
  [#67f482a](https://github.com/dinhanhthi/memlore/commit/67f482a)

## v0.2.0 (2026-09-21)

### Added

- **Local MCP server.** Opt-in under Settings → AI (off by default; a confirmation
  acknowledges that any app running as you on this Mac can read and write the
  decrypted journal). Desktop MCP clients reach six journal tools
  (`list_journals`, `search_entries`, `get_entry`, `create_entry`,
  `append_to_entry`, `set_entry_metadata`) over a local Unix socket via a stdio
  bridge. Settings shows a copy-paste Claude Desktop snippet from the running
  binary path, a default-journal picker, and a running status; the editor
  refreshes when a client writes the open entry. Works without an AI provider.
  [#025980f](https://github.com/dinhanhthi/memlore/commit/025980f)
  [#8b79a17](https://github.com/dinhanhthi/memlore/commit/8b79a17)
  [#b31390c](https://github.com/dinhanhthi/memlore/commit/b31390c)
  [#2dbee85](https://github.com/dinhanhthi/memlore/commit/2dbee85)
  [#639cc27](https://github.com/dinhanhthi/memlore/commit/639cc27)
  [#8b129e5](https://github.com/dinhanhthi/memlore/commit/8b129e5)

### Fixed

- **Clay sidebar nav hover.** Restored the hover rule dropped in `5955fad`.
  [#54a8c0d](https://github.com/dinhanhthi/memlore/commit/54a8c0d)

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
