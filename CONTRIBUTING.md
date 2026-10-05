# Contributing to Memlore

Thanks for helping. Memlore is a local-first, privacy-first journal: no telemetry, no developer-hosted user data, no "phone-home" features.

## Setup

Prerequisites: Rust 1.88+, Node.js 20+, pnpm 9+, and [Tauri's native deps](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/dinhanhthi/memlore.git
cd memlore
pnpm install
pnpm tauri dev
```

Optional: copy `.env.example` to `.env` for Google Drive OAuth in development.

### Local bundle

```bash
pnpm tauri build --no-sign --bundles app
```

Both flags are needed: the release config wants an updater signing key and a provisioning profile, which are not in the repo. Signed bundles come from CI on a `v*` tag, or from `scripts/build-signed-app.sh` for maintainers with the certificate. That script is also the only way to test Touch ID unlock; read its header before touching signing.

## Cargo build cache

`src-tauri/Cargo.toml` keeps debug builds small (a default macOS debug target grows past 10 GB):

```toml
[profile.dev]
opt-level = 1
split-debuginfo = "off"     # no per-codegen-unit .o files

[profile.dev.package."*"]
debug = "line-tables-only"  # dependencies keep file:line backtraces
incremental = false         # dependencies only; memlore stays incremental
```

To share one cache across Rust projects, create `~/.cargo/config.toml` once per machine (outside git) with `target-dir = ".cargo/shared-target"` under `[build]` (relative to `$HOME`) and the **same** profile as above. Profiles that differ make Cargo build every dependency twice.

- `pnpm tauri dev` and `cargo test` then use `~/.cargo/shared-target`; `pnpm tauri build` and `scripts/build-signed-app.sh` still pin `src-tauri/target` so bundles stay in the repo.
- Delete the old `src-tauri/target` after switching.
- Build one project at a time (Cargo locks the directory).
- Never run `cargo clean` / `pnpm cargo:clean`: it wipes the cache of every project.

## UI playground (`mockup/`)

The real app UI over a mocked Tauri backend and fake-data scenarios, without compiling Rust:

```bash
pnpm mockup:dev   # http://localhost:5175, pick a scenario or use ?scenario=<id>
```

Never change `src/` to make the mockup happy; fix `mockup/mocks/` instead. See [`mockup/README.md`](mockup/README.md).

## Web companion (`web/`)

`web.memlore.app`: the same `src/App.tsx` over a browser backend that talks to Google Drive directly, plus a small OAuth Worker in `workers/web-auth/`.

Extra toolchain:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version =0.2.118 --locked   # must match Cargo.lock
```

`scripts/web-wasm.sh --check-only` verifies the installed version.

### Run it locally

One-time setup:

1. In the Google Cloud project of your desktop dev client, create a **Web application** OAuth client with origin `http://localhost:5176` and redirect URI `http://localhost:5176/api/oauth/callback`. Step by step: [`docs/gdrive-oauth-setup.md` → Web client](docs/gdrive-oauth-setup.md#web-client-only-for-the-web-companion-web). It must be the same project, or the web sees an empty Drive.
2. Create `workers/web-auth/.dev.vars` (gitignored; the web does not read the desktop's env file) with that client's credentials and a fresh cookie key:

   ```
   GOOGLE_CLIENT_ID=...       # the Web client, not the Desktop one
   GOOGLE_CLIENT_SECRET=...
   COOKIE_KEY=...             # openssl rand -base64 32
   ```

   Without it, sign-in fails with `500` on `/api/oauth/start`.

Then one command runs the OAuth Worker (:8787) and the web app (:5176) together, each with a coloured prefix. Ctrl+C stops both:

```bash
pnpm web:local          # hot reload, for coding (no CSP headers)
pnpm web:local --prod   # production bundle + the CSP from web/static/_headers, for testing
pnpm web:local --var WEB_WRITES_ENABLED:1   # extra args go to the Worker: here, writes on
```

Open `http://localhost:5176` in Chrome or Firefox (not `127.0.0.1`). The web app calls the Worker under `/api` on the same origin, as in production, so it never works without it. Test with `--prod` before shipping. To run the two halves in separate terminals instead: `pnpm web-auth:dev` and `pnpm web:dev` (or `pnpm web:build && pnpm web:preview`). `pnpm web:local` and `pnpm web-auth:dev` stop this repo's earlier local runs on those ports; another program there is reported, not killed.

Signing in with your real Google account opens your real vault; test writes with a throwaway account and vault.

### Web tests

```bash
pnpm web:test                 # isolated from the desktop `pnpm test`
cd src-tauri && cargo test golden_
```

- `*.wasm.test.ts` files run against the real WASM core.
- If the envelope or outbox format changes, regenerate the golden fixtures (`MEMLORE_REGEN_FIXTURES=1 pnpm web:fixture:envelopes`, `pnpm web:fixture:outbox`) and make sure both commands above pass.

## Releasing

Maintainers ship with `/cf-ship --mac` (desktop, `v*` tags) or `/cf-ship --web` (web companion, `web-v*` tags). The web is deployed only from a `web-v*` tag. See [`.coding-friend/skills/cf-ship-custom/README.md`](.coding-friend/skills/cf-ship-custom/README.md).

## How we work

1. Open an issue (or comment on one) before large changes.
2. Branch from `main`: `feat/…`, `fix/…`, or `docs/…`.
3. One concern per PR. Describe what changed, why, and how you tested it.

## Code

- **TypeScript / React:** functional components, no `any`. Components never call Tauri `invoke()` directly; use hooks in `src/hooks/`.
- **Rust:** one command, one job. All DB access goes through `src-tauri/src/db/`. Commands return `Result<T, String>`.
- **UI:** semantic Tailwind tokens (`bg-panel-1`, `text-fg`, …), never hex colors. Use `<Button>`, `<Modal>` and `<Tooltip>` from `src/components/common/`. Lucide icons sized with `className="size-*"`.
- **i18n:** strings live in `src/locales/{en,vi}/`. Add or remove keys in **both** locales.
- **Privacy:** never send journal content to a server we control. AI stays user-configured.

## Tests

No `.test.tsx` component tests. Cover hooks, stores, utilities and Rust commands.

```bash
pnpm test
cd src-tauri && cargo test
pnpm exec playwright test    # e2e, when the change needs it
```

Frontend tests mock `invoke()`; Rust DB tests use in-memory SQLite; video thumbnail tests need `ffmpeg` (`brew install ffmpeg`).

## Commits

One conventional line, no body: `feat: …`, `fix: …`, `docs: …`, `style: …`, `refactor: …`, `test: …`, `chore: …`, with an optional scope (`fix(sync): …`).

## License

By contributing you agree that your work is licensed under [AGPL-3.0-or-later](LICENSE).
