<div align="center">
  <img src="public/logo-with-container/logo-iOS-Default-256x256@2x.png" width="80" alt="Memlore logo" />
  <h1>Memlore</h1>
  <p>A little life. A lasting story.<br />A cross-platform, privacy-first, local-first journal — with rich, optional AI.</p>
  <p>
    <a href="https://memlore.app">Website</a> ·
    <a href="https://dl.memlore.app/mac">Download for Mac</a> ·
    <a href="https://memlore.app/#demo">Live demo</a>
  </p>
</div>

> [!WARNING]
> Memlore is under active development. What is here today is reasonably stable, with a lot more still to come. Current focus is the **desktop macOS** app and the **web** version; Windows, Linux, iOS, and Android are planned.

<img src="public/screenshot.png" width="100%" alt="Screenshot" />

## ✨ Features

- **Local-first & private** — works fully offline. Your journal stays on your device. No Memlore server, no account, no telemetry.
- **Rich editor** — write with markdown shortcuts, then add plugins for anything: math, code, tables, checklists, media, and more.
- **Find anything** — instant search, tags, favorites, calendar, and On This Day lookback.
- **Media & places** — photos, video, voice memos, a media gallery, and a locations map.
- **AI, when you want it** — a rich set of optional AI tools over your journal. Bring your own provider or run models on-device. Off until you opt in.
- **MCP server** — opt in to let desktop MCP clients search, read, create and append entries on your machine, so you can journal from the AI app you already use. Local only, off by default, and no AI provider required.
- **Sync you control** — encrypted sync over your own Google Drive or iCloud Drive, with more services coming. Recover across devices, see who is connected, and revoke any of them.
- **Locks** — lock the app with a password or Touch ID. Second lock hides chosen entries behind an extra password. Invisible lock keeps separate vaults that vanish until you enter the right password.
- **Import & export** — import from Day One, Journey, Apple Journal, markdown, and more; export to files.
- **Yours to look at** — UI and layout are highly customizable, with different design systems and layouts to choose from.

## 💻 Platforms

**macOS** (desktop) is the only supported target today. Windows, Linux, iOS, and Android are planned.

## 🛠️ Tech stack

| Layer  | Technology                                                                           |
| ------ | ------------------------------------------------------------------------------------ |
| App    | Tauri 2 (Rust) + React 19 + TypeScript + Vite                                        |
| UI     | Tailwind CSS v4, Zustand, i18next, Leaflet, Recharts                                 |
| Editor | TipTap + Yjs (CRDT)                                                                  |
| Data   | SQLite / SQLCipher, FTS5                                                             |
| Crypto | AES-256-GCM, Argon2id                                                                |
| Sync   | Yjs over iCloud Drive / Google Drive                                                 |
| AI     | HTTP providers + opt-in on-device embedding (`fastembed`) and `llama-server` sidecar |

## 🚀 Development

**Prerequisites:** [Rust](https://rustup.rs/) 1.88+, [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/) 9+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. VS Code: install the recommended extensions when prompted (format-on-save + ESLint).

`web/` is the in-browser preview of the Tauri app UI (mocked backend). `website/` is the public marketing site and interactive demo at [memlore.app](https://memlore.app).

```bash
pnpm install
pnpm tauri dev                    # native app
# MEMLORE_REACT_DEVTOOLS=1 pnpm tauri dev   # optional, after `npx react-devtools`

pnpm web:dev                      # app UI preview (web/) — http://localhost:5175
pnpm web:build && pnpm web:preview

pnpm website:dev                  # marketing site (website/) — http://localhost:5176
pnpm website:build && pnpm website:preview

pnpm test                         # frontend
cd src-tauri && cargo test        # backend
pnpm lint && pnpm format:check

pnpm tauri build --no-sign        # current platform (see CONTRIBUTING.md)
```

### Cargo build cache

A debug target on macOS grows past 10 GB. The `dev` profile in `src-tauri/Cargo.toml` keeps a fresh build small. To share that cache, `~/.cargo/config.toml` is created once per machine and stays outside git. Cargo does not expand `~`; the path below is `~/.cargo/shared-target`:

```toml
[build]
target-dir = ".cargo/shared-target"

[profile.dev]
opt-level = 1
split-debuginfo = "off"

[profile.dev.package."*"]
debug = "line-tables-only"
incremental = false
```

Keep that profile identical to `src-tauri/Cargo.toml`. After the config is in place, delete this repo's old `src-tauri/target` — `cargo clean` no longer sees it. `pnpm tauri dev` and `cargo test` use the shared directory. `pnpm tauri build` still writes `src-tauri/target`. Why these flags are set is in [CONTRIBUTING.md](CONTRIBUTING.md#cargo-build-cache).

Optional `.env` (copy `.env.example`): [Google Drive OAuth](docs/gdrive-oauth-setup.md) and [MapKit JS](docs/mapkit-js-setup.md).

### 📦 Releasing

Releases are cut with `/cf-ship`, a custom guide for
[Coding Friend](https://github.com/dinhanhthi/coding-friend) — an AI coding
assistant toolkit of skills, agents and hooks. Its skills live in
`.coding-friend/skills/` and are version-controlled so the release procedure
travels with the repo (`.coding-friend/config.json` stays local).

`.coding-friend/skills/cf-ship-custom/` holds that procedure:

| File                                                          | What it does                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`README.md`](.coding-friend/skills/cf-ship-custom/README.md) | Usage guide — which command for which situation, and what to check when a release misbehaves                           |
| `SKILL.md`                                                    | The contract the assistant follows, loaded on demand                                                                   |
| `scripts/bump-info.sh`                                        | Reads commits since the last published tag, names the release state, and computes the next version. Writes nothing     |
| `scripts/bump.sh`                                             | Writes the version into `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, then verifies all four agree |

Releases are stable by default; `--rc` / `--beta` opt into a GitHub prerelease,
which is what keeps a build off the stable update channel. Changes under
`website/`, `web/`, `docs/` and `e2e/` never drive a version bump. See
[`.github/release-setup.md`](.github/release-setup.md) for the signing and
notarization secrets CI needs.

### 🔄 Reset local state

```bash
# Quit the app first
./scripts/reset-machine.sh           # interactive
./scripts/reset-machine.sh --force   # non-interactive local wipe
```

Wipes the app data dir, Keychain biometric key, and WebView caches. Cloud appdata (Google Drive hidden folder, iCloud) is not deleted automatically — disconnect or wipe from the app / provider UI if you need a clean cloud too.

Need demo data: Settings → Data → **Import** → **Seed demo data**.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 🙏 Credits

The [`website/`](website/) landing page visual style is adapted from [TablePro Web](https://github.com/TableProApp/web).

## 📄 License

Memlore is licensed under [AGPL-3.0-or-later](LICENSE).
