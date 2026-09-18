# Google Drive OAuth Setup

Memlore uses **OAuth 2.0 with PKCE** to connect to Google Drive. No server required — the app uses a Desktop app credential type, which means the `client_secret` is not a real secret (Google requires it during token exchange, but it ships in every binary; PKCE is what actually protects the flow).

The app requests the `drive.appdata` scope — its sync data lives in a hidden, app-private Application Data folder that is **not visible** from drive.google.com. The user cannot accidentally rename, move, or delete the sync folder from the Drive web UI. Same approach Day One, Journey, and other privacy-first journaling apps use.

---

## Create credentials (~10 min, one-time)

### 1. Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/) → project dropdown → **New Project**.
2. Name it (e.g., "Memlore Sync") → **Create**.

### 2. Enable the Google Drive API

**APIs & Services → Library** → search **Google Drive API** → **Enable**.

### 3. Configure Google Auth Platform

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
(sidebar: **APIs & Services → Google Auth Platform**). On a new project,
Overview shows **Get Started** — complete that wizard, then check the pages
below.

#### Branding

1. Sidebar → **Branding**.
2. **App name:** `Memlore`.
3. Support / developer contact email: your address.
4. Save.

#### Audience

1. Sidebar → **Audience**.
2. **User type:** **External** (any Google account). Use **Internal** only if
   this is a Google Workspace project limited to your organization.
3. Leave publishing status on **Testing** while you develop (100 test-user cap).
4. **Test users → Add users** — add the Google account you will use to connect
   Drive. Only those accounts can finish OAuth while the app is in Testing.

> ⚠️ **Testing status expires refresh tokens after 7 days**, so every user has
> to reconnect Drive weekly. That is fine for development and **must not ship**
> — see "Going to production" below.

#### Data Access

1. Sidebar → **Data Access** → **Add or remove scopes**.
2. Add `https://www.googleapis.com/auth/drive.appdata`.
3. Save.

#### Clients

1. Sidebar → **Clients** → **+ Create client**.
2. Application type: **Desktop app** → name it → **Create**.
3. Copy both the **Client ID** and the **Client Secret**.

> **"This app isn't verified" warning** is expected during development. Click
> **Advanced → Go to Memlore (unsafe)** to proceed. Skip **Verification Center**
> until you publish.

---

## Going to production

**This step is required before a public release.** While publishing status is
**Testing** with an **External** user type, Google issues refresh tokens that
expire after **7 days** — so every user is silently logged out of Drive sync
once a week and has to reconnect. From Google's OAuth docs, verbatim:

> "A Google Cloud Platform project with an OAuth consent screen configured for
> an external user type and a publishing status of 'Testing' is issued a refresh
> token expiring in 7 days"

The fix is to publish the app: **Google Auth Platform → Audience → Publish app**,
which moves publishing status to **In production**.

### No heavyweight verification is needed

Memlore requests exactly one scope — `drive.appdata`
(`src-tauri/src/sync/gdrive_oauth.rs:56`) — which Google classifies as
**non-sensitive**, because the app can only ever see its own hidden
`appDataFolder`:

> "If your app utilizes only **non-sensitive** scopes, it is not mandatory for
> your app to complete the app verification process."

No CASA assessment, no annual audit, no multi-week review. Those apply to
_restricted_ Drive scopes (`drive`, `drive.readonly`, `drive.metadata`, …), which
this app deliberately avoids — do not widen the scope without re-reading this.

### What publishing actually requires

An app name, a support email, a **Homepage URL** (the deployed `website/` origin)
and a **Privacy policy URL** (`{homepage}/privacy.html`). Terms and a logo are
optional.

Google rejects one error at a time. The two this project hit:

#### "not registered to you" — verify the domain in Search Console

Google Cloud reads ownership from **Search Console only**; Google Analytics proves
nothing here. Verify with the **same account that owns the Cloud project** (or add
that account under Search Console → Settings → Users and permissions as an Owner),
using a **Domain property** + DNS TXT record — one record covers `www`, http/https
and every subdomain. Then add the domain under **Branding → Authorized domains**
and re-save the URLs.

#### "does not have sufficient content" — the pages must work without JavaScript

**Google's reviewer fetches raw HTML and runs no JS.** Every `website/` page is a
React entry point, so its shell is empty: the policy reads as blank, and the
homepage shows no app description and no privacy link. The `prerenderStaticShells`
plugin in `website/vite.config.ts` bakes the copy in at build time —
`src/legal/markdown.ts` for the legal pages, `src/prerender.ts` for the landing,
both sourced from `src/content.ts` so the static text is never crawler-only.
`website/tests/legal.spec.ts` asserts the raw HTTP body; do not delete it, because
every other test runs JS and would pass on a blank page.

Check the deploy the way Google does, and only then resubmit:

```bash
curl -s https://memlore.app/privacy.html | grep -c "Limited Use"   # >= 1
curl -s https://memlore.app/ | grep -c "privacy.html"              # >= 1
```

The policy must say what Google data is accessed, how it is used, shared,
protected, retained and deleted, plus that it is not sold to data brokers and not
used for ads, AI training, or credit decisions. `website/src/legal/privacy.md`
covers this; `website/tests/content.test.ts` guards it.

### Verification Center has two cards — only one can block you

| Card            | Gates                                 | Memlore                                                            |
| --------------- | ------------------------------------- | ------------------------------------------------------------------ |
| **Data access** | Sensitive / restricted scopes         | "Verification is not required" — `drive.appdata` is non-sensitive  |
| **Branding**    | App name + logo on the consent screen | Cosmetic. Unresolved = "Your branding is not being shown to users" |

Brand verification is the "lighter-weight verification process" Google mentions for
showing an app name and logo. Skipping it costs only that.

Three things that cost an afternoon to learn:

- The Audience page's "Your app requires verification" banner is generic and
  contradicts the Data access card. Ignore it.
- A Branding card reading "Resolve the following issues and verify again" means
  **nothing is queued** — no review is running and no email is coming. There is no
  progress indicator anywhere, and no API or `gcloud` command reports one.
- Passing brand verification does **not** clear the **OAuth user cap** on
  Audience — it keeps reading "N users / 100 user cap" forever. The cap belongs to
  the Data access card, not Branding, and Google's own note on that page says it
  "does not apply if you are requesting only approved sensitive or restricted
  scopes". With `drive.appdata` alone the counter is dormant, not pending: it is
  lifetime, never decreases (not even after a user revokes), and cannot be raised
  or reset. Widening to `drive` / `drive.readonly` / `drive.metadata` later would
  switch it on with the early grants already spent.

**Once the pages are genuinely fixed, pick "I believe the issues found are
incorrect"** — its subtitle is "Request additional review", and that is the path
that gets the live site looked at again. "I have fixed the issues" ("Request
re-verification") queued nothing here, however many times it was submitted: the
card never changed and no email ever arrived. The wording feels wrong, but by then
the listed issues really are stale — verify with the `curl` checks above first, so
the claim is true when you make it.

**Publishing status is the only thing that matters, and it lives on Audience, not
here.** Set it to **In production** there.

### After publishing — verify it actually took

1. Connect Drive with a Google account that was never a test user. Without brand
   verification the app appears as **"Memlore (Unverified)" with no logo** — on the
   consent screen and under drive.google.com → Settings → Manage apps. Expected,
   not a misconfiguration: the logo set in the Cloud project is simply not served
   until brand verification passes.
2. Leave it more than 7 days, then confirm sync still runs without a reconnect
   prompt. This is the only real proof; nothing in the console reports it.

---

## Dev setup (per developer)

The local DB is **SQLCipher-encrypted** (the key is derived from your password). External tools like `sqlite3` cannot write to it, so dev credentials are baked into the binary at **compile time** via env vars — Rust's `option_env!()` macro picks them up when cargo builds `src-tauri`.

**First time only:**

1. Put your credentials in `.env` at the repo root (gitignored):

   ```bash
   GDRIVE_CLIENT_ID=123-abc.apps.googleusercontent.com
   GDRIVE_CLIENT_SECRET=GOCSPX-xxxxxxxx
   ```

2. Launch the app:

   ```bash
   pnpm tauri dev
   ```

   `src-tauri/build.rs` reads `.env` and forwards `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` to cargo via `rustc-env`. A real shell env var of the same name (if you choose to `export` instead) always wins over the `.env` file. Cargo rebuilds the crate whenever `.env` changes or those vars are flipped, so updates take effect on the next `pnpm tauri dev`.

Each developer uses their own Desktop client from Google Cloud Console. `.env` is gitignored — never commit client IDs or secrets.

**Test the flow:**

1. `pnpm tauri dev`
2. Settings → Security → enable **Password Lock** (required — sync needs a password-derived key)
3. Settings → Sync → **Connect Google Drive** → authorize in browser
4. Sync starts in the background. The `Memlore/{device_id}/{entries,media}/` tree is created inside the hidden Application Data folder — **invisible from drive.google.com**. To verify sync is working, check the in-app sync status indicator (footer bar).

---

## Production builds

Bake credentials into the binary at compile time (same mechanism as dev):

```bash
GDRIVE_CLIENT_ID="..." GDRIVE_CLIENT_SECRET="..." pnpm tauri build
```

Runtime resolution order: `settings` table (DB) → `option_env!` (compile-time) → placeholders. The DB path is reserved for future in-app credential entry; today, dev and prod both use the compile-time env-var path.

---

## Security properties

| Property            | Behavior                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PKCE**            | S256 PKCE on every authorization — prevents code interception.                                                                                                                                                                                      |
| **State parameter** | Random CSRF token verified on every callback.                                                                                                                                                                                                       |
| **Redirect URI**    | `http://127.0.0.1:{OS_ASSIGNED_PORT}` — OS picks a free port at runtime.                                                                                                                                                                            |
| **Access token**    | In-memory only — never written to disk. Wiped on app close.                                                                                                                                                                                         |
| **Refresh token**   | Stored in the SQLCipher-encrypted local DB (`gdrive_refresh_token` setting) — protected at rest by your password-derived DB key. It is **not** separately AES-256-GCM-wrapped with the master key; protection is the SQLCipher database encryption. |
| **Scope**           | `drive.appdata` — sync data lives in a hidden app-private folder, invisible to the user from drive.google.com and inaccessible to any other app.                                                                                                    |
| **client_secret**   | Not a real secret in Desktop flows — ships in every binary. PKCE is the actual protection.                                                                                                                                                          |

---

## Troubleshooting

**ACCESS_DENIED** — your account isn't listed under **Google Auth Platform → Audience → Test users**.

**redirect_uri_mismatch** — confirm the credential type is **Desktop app** (not Web application). Google auto-permits `127.0.0.1` loopback for Desktop apps.

**invalid_client** / **Access blocked: Authorization Error** (The OAuth client was not found, Error 401) — the binary was built without your credentials, so it's using the placeholder client ID. Fix:

1. Confirm `.env` at the repo root contains a non-empty `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` (no quotes needed, no spaces around `=`).
2. Stop the current `pnpm tauri dev` and restart it — cargo bakes env vars in at compile time. `build.rs` declares `rerun-if-changed=../.env`, so saving the file triggers a recompile on the next launch.
3. If you've already restarted and the error persists, double-check the values in `.env` against the Google Cloud Console credentials page, then run `pnpm cargo:clean` to force a full rebuild.

**Connection times out** — same root cause as above: placeholder credentials. Apply the same fix.

**`fingerprint mismatch` / `was encrypted under a different master key`** — there are entry payloads in Google Drive that were encrypted under a master key that no longer exists locally. This happens when the local DB was reset (`./scripts/reset-machine.sh` or manual delete) while the Drive folder still held entries from the prior installation. The on-Drive `keyring.json` and the orphan entries belong to two different master keys.

The on-Drive data is unreadable from the new install (zero-knowledge encryption — by design), so the cleanest fix is to wipe the Drive folder and start fresh:

1. In Memlore: Settings → Sync → **Disconnect**.
2. In a browser, go to [drive.google.com](https://drive.google.com) → Settings (gear) → **Manage apps** → find **Memlore** → **Options → Disconnect from Drive**. This is the only way users can wipe `drive.appdata` data, since it's not visible in the regular Drive UI. **Local journal data on your device is untouched.**
3. Back in Memlore: Settings → Sync → **Connect Google Drive**. A fresh keyring and entries folder will be created from your current local state.

If you need to _preserve_ the orphan cloud data, the only path is to restore the original local DB (`memlore.db` + `memlore.db.boot`) that held the original master key — there is no key-recovery flow for entries whose master key was lost.
