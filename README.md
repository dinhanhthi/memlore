<div align="center">
  <img src="public/logo-with-container/logo-iOS-Default-256x256@2x.png" width="80" alt="Memlore logo" />
  <h1>Memlore</h1>
  <p>Your personal lore, your life, remembered.<br />A cross-platform, privacy-first, local-first journal — with rich, optional AI.</p>
</div>

> [!WARNING]
> Memlore is under **heavy development**. There is no production release yet — APIs, schemas, and data formats can change freely. Current work focuses on the **desktop macOS** app. Windows, Linux, iOS, and Android are planned and coming soon.

<img src="public/screenshot.png" width="100%" alt="Screenshot" />

## Features

- **Local-first & encrypted** — works fully offline. Entries stay on your device, encrypted at rest (SQLCipher + AES-256-GCM). No Memlore server, no account, no telemetry.
- **Rich editor** — TipTap WYSIWYG with markdown shortcuts, tables, checklists, code, math, and inline media.
- **Find anything** — instant full-text search (SQLite FTS5), tags, favorites, calendar, and On This Day lookback.
- **Media & places** — photos, video, voice memos, a media gallery, and a locations map.
- **AI-rich, optional** — Daily Chat over your journal, semantic search, and writing help. Bring your own provider (OpenAI, Anthropic, Ollama, CLI, …) or run models on-device. Off until you opt in.
- **Sync you control** — end-to-end encrypted sync over your own Google Drive or iCloud Drive. Multi-device recovery phrase, device list, and revoke.
- **Locks** — app password + Touch ID, second lock, and invisible vaults.
- **Import & export** — Apple Journal folder import; `.memlore.zip`, Markdown, and plain-text export.
- **Yours to look at** — Home dashboard, statistics, three design systems (Signature, Clean, Clay), light/dark, English and Vietnamese.

## Platforms

**macOS** (desktop) is the only supported target today. Windows, Linux, iOS, and Android are planned.

## Tech stack

| Layer  | Technology                                                                           |
| ------ | ------------------------------------------------------------------------------------ |
| App    | Tauri 2 (Rust) + React 19 + TypeScript + Vite                                        |
| UI     | Tailwind CSS v4, Zustand, i18next, Leaflet, Recharts                                 |
| Editor | TipTap + Yjs (CRDT)                                                                  |
| Data   | SQLite / SQLCipher, FTS5                                                             |
| Crypto | AES-256-GCM, Argon2id                                                                |
| Sync   | Yjs over iCloud Drive / Google Drive                                                 |
| AI     | HTTP providers + opt-in on-device embedding (`fastembed`) and `llama-server` sidecar |

## Development

**Prerequisites:** [Rust](https://rustup.rs/) 1.77+, [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/) 9+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. VS Code: install the recommended extensions when prompted (format-on-save + ESLint).

```bash
pnpm install
pnpm tauri dev                    # native app
# MEMLORE_REACT_DEVTOOLS=1 pnpm tauri dev   # optional, after `npx react-devtools`

pnpm web:dev                      # browser UI preview — http://localhost:5175
pnpm web:build && pnpm web:preview

pnpm test                         # frontend
cd src-tauri && cargo test        # backend
pnpm lint && pnpm format:check

pnpm tauri build                  # current platform
```

Google Drive OAuth (optional): put `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` in `.env` at the repo root, then `pnpm tauri dev`. Copy `.env.example`.

### Reset local state

Quit the app first.

```bash
./scripts/reset-machine.sh           # interactive
./scripts/reset-machine.sh --force   # non-interactive local wipe
```

Wipes the app data dir, Keychain biometric key, and WebView caches. Cloud appdata (Google Drive hidden folder, iCloud) is not deleted automatically — disconnect or wipe from the app / provider UI if you need a clean cloud too.

After unlock in a debug build: Settings → Data → **Import** → **Seed demo data**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Memlore is licensed under [AGPL-3.0-or-later](LICENSE).
