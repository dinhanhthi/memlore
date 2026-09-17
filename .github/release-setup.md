# Release setup

Everything `.github/workflows/release.yml` needs in order to publish a signed,
notarized macOS build. Maintainer reference — you only do this once.

> This lives in `.github/` rather than `docs/` on purpose: `docs/` is gitignored
> in this repository, so anything written there never reaches a clone.

## How a release happens

1. `/cf-ship` decides the version bump from the commits, updates `CHANGELOG.md`
   and the website changelog, and bumps the four version files.
2. Pushing a `v*` tag triggers `release.yml`.
3. The workflow signs with Developer ID, notarizes through App Store Connect,
   builds a universal binary, and uploads `.dmg`, `.app.tar.gz`,
   `.app.tar.gz.sig` and `latest.json` to a GitHub Release.
4. Installed apps read `latest.json` and offer the update.

A tag containing `-beta` or `-rc` is published as a **prerelease**. That single
flag is what separates the channels: the stable endpoint is
`/releases/latest/download/latest.json`, and GitHub's "latest" excludes
prereleases, so stable users never see a beta. The beta channel resolves the
newest release — prereleases included — through the API.

## Required secrets

Set at
<https://github.com/dinhanhthi/memlore/settings/secrets/actions>.

### Code signing

| Secret                       | What it is                                                     | How to produce it                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of the Developer ID Application certificate as a `.p12` | Keychain Access → My Certificates → right-click _Developer ID Application_ → Export as `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password set while exporting that `.p12`                   | Chosen at export time                                                                                                              |
| `KEYCHAIN_PASSWORD`          | Any random string                                              | Only ever used for a throwaway keychain inside the CI runner                                                                       |

`APPLE_SIGNING_IDENTITY` is deliberately **not** a secret. The workflow reads it
back out of the certificate it just imported, so it cannot drift from the
certificate actually in use.

### Notarization (App Store Connect API key)

| Secret             | What it is                                | How to produce it                                                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `APPLE_API_ISSUER` | Issuer ID (UUID)                          | App Store Connect → Users and Access → Integrations → App Store Connect API; shown above the keys table |
| `APPLE_API_KEY`    | Key ID (~10 chars)                        | Same table, _KEY ID_ column                                                                             |
| `APPLE_API_KEY_P8` | Base64 of the `AuthKey_*.p8` **contents** | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy`                                                             |

The `.p8` downloads **once** and Apple will not re-issue it — keep a copy in a
password manager. `APPLE_API_KEY_PATH`, which Tauri actually reads, is a file
path the workflow creates from `APPLE_API_KEY_P8`; it is not a secret.

### Updater signing (minisign)

| Secret                               | What it is                                   | How to produce it                                    |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | The minisign private key, password-encrypted | `pnpm tauri signer generate -w ~/.tauri/memlore.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password                                 | Chosen at generation time                            |

> **This key cannot be rotated after the first release.** Its public half is
> compiled into every shipped build (`tauri.conf.json` → `plugins.updater.pubkey`)
> and Tauri's updater has no in-band key rotation. Replacing it means every
> existing install silently stops being able to verify updates and has to be
> re-downloaded by hand. Keep the private key and its password in a password
> manager, and **never re-run `signer generate`** for this project.

### Provisioning profile

| Secret                    | What it is                                                                | How to produce it                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MACOS_PROVISION_PROFILE` | Base64 of a **Developer ID** macOS provisioning profile for `app.memlore` | developer.apple.com → Profiles → **+** → Distribution → _Developer ID_, then `base64 -i x.provisionprofile \| pbcopy` |

This one is not optional. `src-tauri/Entitlements.release.plist` declares
`keychain-access-groups`, which Touch ID unlock needs
(`src-tauri/src/commands/keychain.rs`, `BIOMETRY_CURRENT_SET`), and that
entitlement is provisioning-profile restricted: a bundle declaring it without a
valid embedded profile is **killed at spawn on every user's machine**. The
profile is embedded via `tauri.conf.json` → `bundle.macOS.files`, which the
bundler copies in before codesign runs.

Two traps worth knowing:

- It must be a **Developer ID** profile (`ProvisionsAllDevices => true`). A _Mac
  Development_ profile pins `ProvisionedDevices` to specific machines and cannot
  be distributed. The workflow rejects the wrong type rather than shipping it.
- An **expired** profile produces an app that launches for nobody. The workflow
  fails the build when under 30 days remain.

### Build-time configuration

`src-tauri/build.rs` embeds these into the binary through `option_env!` at
compile time. A build without them still succeeds and still launches — it just
ships with dead Google Drive sync, blank maps and no Google Fonts, which only
users discover. The workflow asserts all four are present before building.

| Secret                 | Setup guide                                               |
| ---------------------- | --------------------------------------------------------- |
| `GDRIVE_CLIENT_ID`     | Google Cloud console → OAuth 2.0 Client IDs (Desktop app) |
| `GDRIVE_CLIENT_SECRET` | Same OAuth client                                         |
| `GOOGLE_FONTS_API_KEY` | Google Cloud console → Fonts Developer API                |
| `MEMLORE_MAPKIT_TOKEN` | `scripts/generate-mapkit-token.mjs`                       |

Longer walkthroughs live in `docs/gdrive-oauth-setup.md` and
`docs/mapkit-js-setup.md` — **local-only**, since `docs/` is gitignored. If you
are reading this from a fresh clone, those files are not there; the table above
is self-sufficient.

> 🚨 **Release blocker, not a secret:** the Google Cloud OAuth consent screen
> must be set to **In production**, not **Testing**. A Testing project with an
> External user type issues refresh tokens that expire after **7 days**, so
> every user silently loses Drive sync once a week and has to reconnect. Setting
> the secrets correctly does not fix this — it is a console setting.
>
> Publishing needs no heavyweight review: Memlore requests only `drive.appdata`,
> which Google classifies as **non-sensitive**, so no CASA assessment and no
> annual audit. It does need a Privacy policy URL and a Homepage URL on the
> consent screen. Optional _brand verification_ only affects whether the app
> name and logo appear on Google's consent screen.

## Verifying a release

```bash
gh run list --workflow=release.yml --limit 3

# latest.json must carry a non-empty signature for the platform key the app
# looks up. An empty one is the silent failure mode of updater signing: the
# release looks complete and every client rejects the update.
gh release download <tag> -p latest.json -O - | python3 -m json.tool

# On a Mac that has never built this app — mount the dmg, then:
APP="$(mount | sed -n 's/.* on \(\/Volumes\/Memlore[^ ]*\) .*/\1/p' | head -1)/Memlore.app"
spctl -a -vv -t install "$APP"                      # expect: accepted, Notarized Developer ID
lipo -archs "$APP/Contents/MacOS/Memlore"           # expect: x86_64 arm64
codesign -d --entitlements - "$APP" | grep -c keychain-access-groups   # expect: 1
ls "$APP/Contents/embedded.provisionprofile"        # must exist, or Touch ID is dead
```

Then check in the installed app: Drive sync connects, the map view renders, and
`Memlore > Check For Updates…` reports the right state.

A tag push that prints success is not proof a release started — confirm with
`git ls-remote --tags origin` and `gh run list`.
