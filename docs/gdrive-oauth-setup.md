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
