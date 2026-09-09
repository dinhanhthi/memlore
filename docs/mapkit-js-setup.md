# Apple MapKit JS Setup

Memlore can show Apple Maps in Locations, location previews, and related map UI. That path uses **MapKit JS**. The JWT is baked into the Rust binary at **compile time** — same pattern as Google Drive OAuth (`option_env!` via `src-tauri/build.rs`).

You need an [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year). The Maps ID label in the portal is cosmetic. The token Memlore ships is signed with your **Team ID** + **Key ID**, not the Maps ID string.

Official Apple help: [Create a Maps identifier and private key](https://developer.apple.com/help/account/capabilities/create-a-maps-identifier-and-private-key).

---

## What you will create


| Item                  | Example                            | Where it lives                                             |
| --------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Maps ID (description) | `Memlore`                          | Apple Developer portal only                                |
| Maps ID (identifier)  | `maps.app.memlore`                 | Apple Developer portal only — **cannot be renamed later**  |
| MapKit JS key (`.p8`) | `AuthKey_XXXXXXXXXX.p8`            | **Outside this repo** (never commit; `*.p8` is gitignored) |
| Key ID (`kid`)        | 10-character id from the Keys page | Used when signing the JWT                                  |
| Team ID (`iss`)       | 10-character id on Membership      | Used when signing the JWT                                  |
| JWT                   | long `eyJ…` string                 | Repo-root `.env` as `MEMLORE_MAPKIT_TOKEN` (gitignored)    |


An existing MapKit JS key stays tied to the Maps ID it was created with. A **new** Maps ID needs a **new** key. Each Maps ID can have at most two keys.

---

## 1. Register a Maps ID

1. Sign in at [developer.apple.com/account](https://developer.apple.com/account).
2. Open **Certificates, Identifiers &amp; Profiles** → [Identifiers](https://developer.apple.com/account/resources/identifiers/list).
3. Click **+**.
4. Select **Maps IDs** → **Continue**.
5. **Description:** `Memlore` (this is the human label in the portal list).
6. **Identifier:** a reverse-domain string, for example `maps.app.memlore`.
7. **Continue** → review → **Register**.

The identifier is permanent. If you pick `maps.com.you.xjournal` by mistake, register another Maps ID; do not try to rename it.

---

## 2. Create a MapKit JS private key

1. In the same portal, open [Keys](https://developer.apple.com/account/resources/authkeys/list).
2. Click **+**.
3. Name the key (e.g. `Memlore MapKit JS`).
4. Enable **Maps**.
5. Click **Configure** next to Maps and select the Maps ID from step 1 (`maps.app.memlore`).
6. **Continue** → **Register**.
7. **Download** the `.p8` file. Apple shows it **once**. Store it outside the repo, for example:
  ```text
   ~/Secrets/memlore/AuthKey_XXXXXXXXXX.p8
  ```
8. Copy the **Key ID** shown on that page (10 characters). You will need it as `MAPKIT_KEY_ID`.

Do not put the `.p8` under `/Users/thi/git/memlore` or any other git checkout.

---

## 3. Copy your Team ID

1. Open [Membership details](https://developer.apple.com/account#MembershipDetailsCard).
2. Copy **Team ID** (10 characters). You will need it as `MAPKIT_TEAM_ID`.

---

## 4. Sign a JWT for this repo -&gt; `MEMLORE_MAPKIT_TOKEN`

From the Memlore repo root, using **absolute** paths:

```bash
MAPKIT_KEY_FILE=/absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
MAPKIT_KEY_ID=XXXXXXXXXX \
MAPKIT_TEAM_ID=XXXXXXXXXX \
node scripts/generate-mapkit-token.mjs
```

Equivalent flags:

```bash
node scripts/generate-mapkit-token.mjs \
  --key-file /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --team-id XXXXXXXXXX \
  --expiry-days 180
```

The script prints the JWT on stdout and the expiry on stderr. Default lifetime is **180 days**. After expiry, run the script again and replace the value in `.env`, then rebuild.

### Origin restriction (optional)

`--origin` / `MAPKIT_ORIGIN` locks the JWT to one page origin. Apple then rejects the token everywhere else.

- Omit it for a token that works in both `pnpm tauri dev` (`http://localhost:5173`) and the bundled app (`https://tauri.localhost`).
- Set it only when you ship a single production origin and want a smaller blast radius if the JWT leaks.

```bash
node scripts/generate-mapkit-token.mjs \
  --key-file /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --team-id XXXXXXXXXX \
  --origin https://tauri.localhost
```

---

## 5. Apply the token to Memlore

`src-tauri/build.rs` reads `.env` at the **repo root** and forwards `MEMLORE_MAPKIT_TOKEN` into the compile. Cargo does not load `.env` by itself. A real shell export of the same name wins over the file.

1. If you do not already have a root `.env`, copy the example:
  ```bash
   cp .env.example .env
  ```
2. Add or replace this line (quotes optional; no spaces around `=`):
  ```bash
   MEMLORE_MAPKIT_TOKEN=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9....
  ```
3. Quit any running `pnpm tauri dev`, then start it again:
  ```bash
   pnpm tauri dev
  ```

   Changing `.env` triggers a Rust rebuild. The web preview (`pnpm web:dev`) does **not** bake this token — Apple Maps in the browser harness stays mocked.

### Production / signed builds

```bash
MEMLORE_MAPKIT_TOKEN="eyJ…" pnpm tauri build
```

Or keep the value in `.env` and run `pnpm tauri build` / `./scripts/build-signed-app.sh` from the same repo root. No token → the UI hides the Apple Maps option (`MAPKIT_TOKEN_MISSING`); the rest of the app still runs.

---

## 6. Confirm it worked

1. Unlock the app (dev password is `12345678` after onboarding).
2. Settings → maps / location source (the `map_tile_source` setting).
3. **Apple Maps** should be offered. If the token is missing, that option stays gated off.
4. Open **Locations** (or a location preview) and choose the Apple Maps source. Tiles load from `cdn.apple-mapkit.com`.

If tiles fail: check the JWT is one line, Key ID / Team ID match the portal, the `.p8` is the key you just created, and you fully restarted Tauri after editing `.env`. If you set `--origin`, it must match the webview origin you are actually running.

---

## Do not

- Commit `.p8` keys or `.env`.
- Paste the JWT into source, docs, or chat logs.
- Reuse an old xJournal MapKit JS key on the new Maps ID — create a new key.
- Expect `pnpm web:dev` to exercise real MapKit JS.

Apple also has **Certificates, Identifiers &amp; Profiles → Services → Maps → Configure Tokens**. Memlore does not use that hosted-token flow. Use the Maps ID + `.p8` + `scripts/generate-mapkit-token.mjs` path above.