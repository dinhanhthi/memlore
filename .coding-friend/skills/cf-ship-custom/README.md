# `/cf-ship` for Memlore — usage

How to release Memlore. This file is for **you**; `SKILL.md` next to it is the
contract the model follows.

> `.gitignore` ignores `.coding-friend/*` but re-includes
> `!.coding-friend/skills/`, so this guide, `SKILL.md` and the scripts **are**
> version-controlled and do reach a fresh clone. Only `.coding-friend/config.json`
> stays local.

## Two platforms, shipped separately

Memlore ships two platforms. Each has its own version, its own tags and its own
pipeline, and one never moves the other:

| Platform            | Flag    | Version file                | Tag          | What the tag triggers                                                     |
| ------------------- | ------- | --------------------------- | ------------ | ------------------------------------------------------------------------- |
| Desktop app (macOS) | `--mac` | `src-tauri/tauri.conf.json` | `v0.2.1`     | `release.yml`: signed + notarized `.dmg`, GitHub Release, in-app update   |
| Web companion       | `--web` | `web/version.json`          | `web-v0.1.0` | `deploy-web.yml`: Cloudflare Pages, plus the OAuth Worker when it changed |

| You say          | What happens                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `/cf-ship`       | The model **asks** `--mac`, `--web` or `--all` first. It never guesses.             |
| `/cf-ship --mac` | Desktop only: bump, changelog, `v*` tag, signed release. The web is untouched.      |
| `/cf-ship --web` | Web only: bump, changelog, `web-v*` tag, deploy. The desktop is untouched.          |
| `/cf-ship --all` | Each platform that has changes, independently: its own level, version, tag, deploy. |

All the flags below (`patch|minor|major`, `--rc`, `--beta`) combine with a
platform: `/cf-ship --web --rc`, `/cf-ship --mac minor`.

The web is **never deployed by hand** anymore: a `web-v*` tag is the only way to
production. (Re-running `deploy-web.yml` is allowed from an existing `web-v*`
tag, e.g. after a CI hiccup.) And a web tag **never gets a GitHub Release** —
the desktop updater reads GitHub Releases, so one would break desktop updates.

## What one release actually does

`/cf-ship` reads the commits since the platform's last published tag, picks a
version, runs `pnpm format` and commits the formatter's changes on their own
(`style(release): format before release`), then writes both changelogs, bumps
the version file(s), commits, tags, pushes, and finally waits for CI and
verifies what it published.

- **mac:** CI signs, notarizes and publishes a universal `.dmg` plus the
  `latest.json` the in-app updater reads. **25-35 minutes**, almost all of it
  the universal Rust build and Apple's notarization round-trip.
- **web:** CI tests, builds and deploys to Cloudflare Pages, and redeploys the
  Worker only when `workers/web-auth/` changed since the previous web tag.
  **10-15 minutes.**

## Say it in one line

Shown with `--mac`; every row works the same with `--web` (and `--all`).

**Releases are stable by default.** A prerelease only happens if you ask.

| You want                                      | You say                     | Version goes                           |
| --------------------------------------------- | --------------------------- | -------------------------------------- |
| A normal release                              | `/cf-ship --mac`            | `0.1.0` → `0.1.1`                      |
| Let the model pick the level from the commits | `/cf-ship --mac`            | patch, unless the bar below is cleared |
| Force the level                               | `/cf-ship --mac minor`      | `0.1.0` → `0.2.0`                      |
| A release candidate                           | `/cf-ship --mac --rc`       | `0.1.0` → `0.1.1-rc.1`                 |
| Another candidate after a fix                 | `/cf-ship --mac --rc`       | `0.1.1-rc.1` → `0.1.1-rc.2`            |
| **Promote the candidate to real**             | `/cf-ship --mac`            | `0.1.1-rc.2` → **`0.1.1`**             |
| A beta for the Beta channel                   | `/cf-ship --mac --beta`     | `0.1.0` → `0.1.1-beta.1`               |
| A candidate for a bigger release              | `/cf-ship --mac minor --rc` | `0.1.0` → `0.2.0-rc.1`                 |

### When the model picks the level

**Patch is the default.** A minor bump happens only when the commits since the
last tag contain **both** of these:

1. **Several distinct new features** — more than one, each something a user can
   invoke or opt into on its own. Commits that are pieces of a single feature
   count as one feature.
2. **A large release overall** — many release-relevant commits spanning those
   features, not a short series around one theme.

One new capability is a patch, however large its diff is. So is new UI on a
surface that already exists, and so is a release that is mostly fixes with a
feature mixed in. An `Added` changelog heading does not make the bump minor.
When it is close, the model ships a patch. Pass `minor` yourself only when you
want to override that.

### The promote row is the one to remember

When the current version already ends in `-rc.N` or `-beta.N`, running
`/cf-ship` with **no flag** drops the suffix and keeps the core: `0.1.1-rc.2`
becomes `0.1.1`, not `0.1.2`. The target version was decided when you cut the
candidate, so there is nothing left to bump.

This is why `bump-info.sh` computes the version itself and prints it under
**Next version** — doing that arithmetic by hand (or by model) is how you end up
shipping `0.1.2` and skipping `0.1.1` entirely.

## Who sees what

**Desktop:**

| Release kind             | GitHub         | Stable channel | Beta channel |
| ------------------------ | -------------- | -------------- | ------------ |
| `0.1.1`                  | normal release | ✅ offered     | ✅ offered   |
| `0.1.1-rc.1` / `-beta.1` | **prerelease** | ❌ never       | ✅ offered   |

**Web** has no channels. A stable `web-v0.1.1` deploys `web.memlore.app`; a
`web-v0.1.1-rc.1` / `-beta.1` deploys only the preview URL
(`https://preview.memlore-web.pages.dev`), never production and never the
Worker, and gets no entry on the public changelog page.

That single prerelease flag is the whole channel mechanism: the app's stable
endpoint reads `/releases/latest/download/latest.json`, and GitHub's "latest"
excludes prereleases. The beta channel asks the API for the newest release of
any kind.

**Consequence:** a candidate you never promote is not stranded. Once the stable
version ships it is newer, so beta users move to it on their own. Nothing needs
cleaning up, and published prerelease tags are never deleted.

## Three things that will bite you

**1. You cannot switch prerelease kind on the same version.**
`0.1.1-rc.2` → `0.1.1-beta.1` moves _backwards_: `beta` sorts below `rc` in
semver, so that build is older than what you already published and **no client
would ever be offered it**. The script refuses it. Promote to `0.1.1` first, or
bump the core version.

**2. "Nothing to release" is a real answer.**
Each platform counts only its own paths: `src/` and `public/` (the shared UI)
count for both; `web/` and `workers/` only for web; `src-tauri/` for mac, except
`crates/memlore-core` and `crates/memlore-wasm`, which count for web too.
`website/`, `mockup/`, `docs/` and `e2e/` count for neither, and neither do
`(website)`- or `(release)`-scoped commits. When nothing relevant changed, the
report says `HAS APP CHANGES: no`. That means stop — not "ship a patch anyway"
(with `--all`, that platform is skipped). Website changes deploy through
`deploy-website.yml` on push to `main` and need no version at all.

**3. There are two changelogs, with two audiences.**

| File                                     | For        | Style                                                                                            |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                           | developers | technical; `## v…` sections become the GitHub Release body, `## web-v…` sections are for the web |
| `website/src/changelog/changelogData.ts` | users      | plain language; drives the public changelog page and the version badge on the site               |

Both get updated every release. Web entries carry `platform: 'web'` and show as
"Web v…" with a Web chip. The website badge reads the newest **stable desktop**
entry, so neither a `-rc`/`-beta` nor a web version ever becomes the badge.

## What the report looks like

```
=== Bump Info — memlore --mac: desktop app (macOS) ===

Latest published tag:  v0.1.0
Tag source:            origin
Tag format:            v<version>   (this platform only)
File version:          0.1.0  (src-tauri/tauri.conf.json)
State:                 bump
Commit range:          v0.1.0..HEAD
Requested level:       (none — decide from the commits below)
Prerelease:            no — STABLE (the default; --rc / --beta is opt-in)

--- Next version (computed — do NOT do this arithmetic yourself) ---
  patch    0.1.1
  minor    0.2.0
  major    1.0.0
```

`State` is the thing to read first:

| State                      | Meaning                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bump`                     | Normal. Pick a version and go.                                                                         |
| `already-bumped`           | The version files are ahead of the tag — the bump already happened. Changelog only; do not bump again. |
| `first-release`            | No tag exists at all. Ship the version already in the files.                                           |
| `BROKEN-tag-ahead-of-file` | Something was tagged without bumping. Stop and untangle it by hand.                                    |

## When it goes wrong

**The run fails.** No release is published, so the tag is harmless — fix the
problem and re-push the same tag. Nothing to delete.

**The run is green but the app will not update.** Check `latest.json`: every
platform key needs a non-empty `signature`. An empty one is the silent failure
mode — the release looks perfect and every client refuses the update. Step B8
checks this, but check it yourself if you are suspicious:

```bash
gh release download v<version> -p latest.json -O - | python3 -m json.tool
```

**Gatekeeper warns users.** Notarization did not take. On the downloaded `.dmg`:

```bash
spctl -a -vv -t install "/Volumes/Memlore/Memlore.app"   # want: accepted / Notarized Developer ID
```

**Touch ID stops working in the release.** The provisioning profile did not get
embedded. `Contents/embedded.provisionprofile` must exist inside the shipped
`.app`, or macOS kills the process at launch — see
`scripts/build-signed-app.sh`'s header for why.

## What it does not do

- **Renew the provisioning profile.** It expires in 2044, and `release.yml`
  refuses to build under 30 days remaining. Nothing to do for years.
- **Rotate the updater signing key.** It _cannot_ be rotated — the public half
  is compiled into every shipped build. Never re-run `tauri signer generate`.
  See `.github/release-setup.md`.
- **Release the website.** That is `deploy-website.yml`, triggered by any push
  to `main`. (The web _companion_ is a platform and does go through `/cf-ship --web`.)
- **Release for Windows or Linux.** macOS only today.

## Testing the scripts without releasing anything

Two env hooks let you exercise every branch without touching the real config or
creating a tag. Never set either during a real release — the output labels
itself `TEST MODE` when they are on.

```bash
B=.coding-friend/skills/cf-ship-custom/scripts/bump-info.sh

# Pretend we are sitting on a candidate: shows the promote answer.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --mac

# …and the next candidate.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --mac --rc

# …and the refusal to move backwards.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --mac --beta

# The same for the web (its tags carry the web- prefix).
BUMP_INFO_TAG=web-v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --web

# Pretend nothing was ever released.
BUMP_INFO_TAG= bash $B --web
```

## Files

| Path                               | Role                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`                         | The contract the model follows. Loaded by `load-custom-guide.sh`.                                                   |
| `scripts/bump-info.sh`             | Per platform (`--mac`/`--web`): reads commits and tags, names the state, computes the next version. Writes nothing. |
| `scripts/bump.sh`                  | Per platform: writes the version file(s) — four for mac, `web/version.json` for web — and verifies them.            |
| `.github/workflows/release.yml`    | mac: signs, notarizes, builds universal, publishes.                                                                 |
| `.github/workflows/deploy-web.yml` | web: tests, builds, deploys Pages (production or preview) and the Worker when changed.                              |
| `.github/release-setup.md`         | Every secret the workflow needs, and where it comes from.                                                           |
