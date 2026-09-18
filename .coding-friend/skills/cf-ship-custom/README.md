# `/cf-ship` for Memlore — usage

How to release Memlore. This file is for **you**; `SKILL.md` next to it is the
contract the model follows.

> `.gitignore` ignores `.coding-friend/*` but re-includes
> `!.coding-friend/skills/`, so this guide, `SKILL.md` and the scripts **are**
> version-controlled and do reach a fresh clone. Only `.coding-friend/config.json`
> stays local.

## What one release actually does

`/cf-ship` reads the commits since the last published tag, picks a version,
writes both changelogs, bumps four files, commits, tags, pushes, then waits for
CI and verifies the published artifacts. CI signs, notarizes and publishes a
universal `.dmg` plus the `latest.json` the in-app updater reads. A run takes
**25-35 minutes**, almost all of it the universal Rust build and Apple's
notarization round-trip.

## Say it in one line

**Releases are stable by default.** A prerelease only happens if you ask.

| You want                                      | You say               | Version goes                         |
| --------------------------------------------- | --------------------- | ------------------------------------ |
| A normal release                              | `/cf-ship`            | `0.1.0` → `0.1.1`                    |
| Let the model pick the level from the commits | `/cf-ship`            | ↑ same, it decides patch/minor/major |
| Force the level                               | `/cf-ship minor`      | `0.1.0` → `0.2.0`                    |
| A release candidate                           | `/cf-ship --rc`       | `0.1.0` → `0.1.1-rc.1`               |
| Another candidate after a fix                 | `/cf-ship --rc`       | `0.1.1-rc.1` → `0.1.1-rc.2`          |
| **Promote the candidate to real**             | `/cf-ship`            | `0.1.1-rc.2` → **`0.1.1`**           |
| A beta for the Beta channel                   | `/cf-ship --beta`     | `0.1.0` → `0.1.1-beta.1`             |
| A candidate for a bigger release              | `/cf-ship minor --rc` | `0.1.0` → `0.2.0-rc.1`               |

### The promote row is the one to remember

When the current version already ends in `-rc.N` or `-beta.N`, running
`/cf-ship` with **no flag** drops the suffix and keeps the core: `0.1.1-rc.2`
becomes `0.1.1`, not `0.1.2`. The target version was decided when you cut the
candidate, so there is nothing left to bump.

This is why `bump-info.sh` computes the version itself and prints it under
**Next version** — doing that arithmetic by hand (or by model) is how you end up
shipping `0.1.2` and skipping `0.1.1` entirely.

## Who sees what

| Release kind             | GitHub         | Stable channel | Beta channel |
| ------------------------ | -------------- | -------------- | ------------ |
| `0.1.1`                  | normal release | ✅ offered     | ✅ offered   |
| `0.1.1-rc.1` / `-beta.1` | **prerelease** | ❌ never       | ✅ offered   |

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
If the only commits since the last tag touched `website/`, `web/`, `docs/` or
`e2e/`, or are scoped `(website)`, the report says `HAS APP CHANGES: no`. That
means stop — not "ship a patch anyway". Website changes deploy through
`deploy-website.yml` on push to `main` and need no version at all.

**3. There are two changelogs, with two audiences.**

| File                                     | For        | Style                                                                              |
| ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `CHANGELOG.md`                           | developers | technical; becomes the GitHub Release body                                         |
| `website/src/changelog/changelogData.ts` | users      | plain language; drives the public changelog page and the version badge on the site |

Both get updated every release. The website badge reads the newest **stable**
entry, so a `-rc` or `-beta` version never appears on the public site.

## What the report looks like

```
=== Bump Info — memlore (single package) ===

Latest published tag:  v0.1.0
Tag source:            origin
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
  to `main`.
- **Release for Windows or Linux.** macOS only today.

## Testing the scripts without releasing anything

Two env hooks let you exercise every branch without touching the real config or
creating a tag. Never set either during a real release — the output labels
itself `TEST MODE` when they are on.

```bash
B=.coding-friend/skills/cf-ship-custom/scripts/bump-info.sh

# Pretend we are sitting on a candidate: shows the promote answer.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B

# …and the next candidate.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --rc

# …and the refusal to move backwards.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --beta

# Pretend nothing was ever released.
BUMP_INFO_TAG= bash $B
```

## Files

| Path                            | Role                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `SKILL.md`                      | The contract the model follows. Loaded by `load-custom-guide.sh`.                   |
| `scripts/bump-info.sh`          | Reads commits and tags, names the state, computes the next version. Writes nothing. |
| `scripts/bump.sh`               | Writes the version into all four files and verifies they agree.                     |
| `.github/workflows/release.yml` | Signs, notarizes, builds universal, publishes.                                      |
| `.github/release-setup.md`      | Every secret the workflow needs, and where it comes from.                           |
