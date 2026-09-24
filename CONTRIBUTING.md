# Contributing to Memlore

Thanks for helping. Memlore is a local-first, privacy-first journal. Keep those constraints in mind: no telemetry, no developer-hosted user data, no “phone-home” features.

## Setup

Prerequisites: Rust 1.77+, Node.js 20+, pnpm 9+, and [Tauri’s native deps](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/dinhanhthi/memlore.git
cd memlore
pnpm install
pnpm tauri dev
```

Optional: copy `.env.example` to `.env` if you need Google Drive OAuth in development.

### Building a bundle locally

`pnpm tauri dev` needs nothing extra. Producing a **bundle** does, because the
release configuration is signing-aware and two of its inputs are deliberately
not in the repository:

- `bundle.createUpdaterArtifacts` is on, so the CLI refuses to bundle without an
  updater signing key: _"A public key has been found, but no private key."_
- `bundle.macOS.files` embeds `.ci/memlore.provisionprofile`, which is gitignored
  because it is a signing asset. Without that file the build hard-fails.

So an unprivileged local bundle needs both flags:

```bash
pnpm tauri build --no-sign --bundles app
```

Fully signed bundles are produced by CI on a `v*` tag, and by
`scripts/build-signed-app.sh` for maintainers who hold the certificate and the
Developer ID provisioning profile. That script is also the only way to exercise
Touch ID unlock — `pnpm tauri dev` never can, because the
`keychain-access-groups` entitlement it needs is provisioning-profile
restricted. Read that script's header before touching anything signing-related.

## Cargo build cache

`pnpm tauri dev` and `cargo test` write the `dev` profile to `debug/`. `pnpm tauri build` writes `release/`. On macOS that dev profile defaults to `split-debuginfo = "unpacked"` while debug info is enabled, and each codegen unit drops a `.o` into `target/debug/deps`. That is the bulk of a debug target past 10 GB. `src-tauri/Cargo.toml` sets:

```toml
[profile.dev]
opt-level = 1
split-debuginfo = "off"

[profile.dev.package."*"]
debug = "line-tables-only"
incremental = false
```

`split-debuginfo = "off"` stops those object files. Dependency crates keep line tables, enough for a backtrace to name a file and a line. The `memlore` package keeps full debug info, and incremental compilation stays on for it. `incremental = false` under `package."*"` applies only to dependencies. Changing the profile does not shrink a target that already exists.

Share one cache across Rust projects by creating `~/.cargo/config.toml` once per machine. The file is outside git. Cargo does not expand `~`. A relative path in that file is resolved from `$HOME`, so the value below is `~/.cargo/shared-target`:

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

Copy the profile from `src-tauri/Cargo.toml` and keep the two identical. Profile keys in Cargo's config override the same keys in every `Cargo.toml`. You set this once. A project that leaves `opt-level` at the default `0` compiles a second copy of every dependency next to Memlore's `opt-level = 1` copies. The build still succeeds. The disk holds both.

What lands in the shared directory:

- Dependency artifacts in `debug/deps` when the crate version, features, `rustc`, these profile flags, and the target triple match. Two apps then reuse the same `tauri`, `tokio`, `serde`, and `objc2` builds.
- Each app's own binary, side by side (`debug/memlore` next to another app's binary).

A different feature set stores another copy of that one crate. `cargo clean` (and `pnpm cargo:clean`) deletes the whole shared directory, every project included. Cargo locks the directory, so build one project at a time.

`scripts/dev.sh` does not set `CARGO_TARGET_DIR`. Neither does `pnpm tauri dev` or `cargo test`, so they follow this config. With no config and no environment variable they still use `src-tauri/target`. `scripts/tauri.sh` exports `CARGO_TARGET_DIR` to `src-tauri/target` when the subcommand is `build`, which is what `pnpm tauri build` runs. Leave that pin. It keeps the release bundle at `src-tauri/target/release/bundle/macos/Memlore.app` (and the `.dmg` next to it). `scripts/build-signed-app.sh` exports the same variable so its debug bundle stays at `src-tauri/target/debug/bundle/macos/Memlore.app`. Leave that pin too. An exported `CARGO_TARGET_DIR` still overrides `~/.cargo/config.toml` for dev commands, because the environment outranks the config.

After writing the config on a machine that already has a per-project `target/`, delete those directories. They are no longer on Cargo's path, and `cargo clean` will not see them. The next `pnpm tauri dev` fills `~/.cargo/shared-target`.

## UI playground (`web/`)

`web/` is a browser-only preview of the real app UI. It mounts the same `src/App.tsx` with a mocked Tauri IPC layer and selectable fake-data scenarios — useful for iterating on screens without compiling Rust.

```bash
pnpm web:dev   # http://localhost:5175
```

Pick a scenario from the floating panel (or `?scenario=<id>`). **Never change `src/` components to make the browser happy** — fix `web/mocks/` instead. Details: [`web/README.md`](web/README.md).

## How we work

1. Open an issue (or comment on an existing one) before large changes.
2. Branch from `main`: `feat/…`, `fix/…`, or `docs/…`.
3. Keep PRs focused. One concern per PR.
4. Fill in the PR description: what changed, why, and how you tested it.

## Code

- **TypeScript / React:** functional components, no `any`. Components do not call Tauri `invoke()` — use hooks in `src/hooks/`.
- **Rust:** one command, one job. All DB access goes through `src-tauri/src/db/`. Commands return `Result<T, String>`.
- **UI:** semantic Tailwind tokens (`bg-panel-1`, `text-fg`, …). Do not hardcode hex colors. Use `<Button>`, `<Modal>`, and `<Tooltip>` from `src/components/common/`. Lucide icons with `className="size-*"` — no `width`/`height` props.
- **i18n:** user-facing strings live in `src/locales/{en,vi}/`. Add or remove keys in **both** locales.
- **Privacy:** never send journal content to a server we control. AI stays user-configured (their key, their host, or on-device).

## Tests

Do not add `.test.tsx` component tests. Cover hooks, stores, utilities, and Rust commands.

```bash
pnpm test
cd src-tauri && cargo test
pnpm exec playwright test    # e2e, when the change needs it
```

- Frontend tests mock Tauri `invoke()` — they must not call a real backend.
- Rust DB tests use in-memory SQLite.
- Video thumbnail tests need `ffmpeg` (`brew install ffmpeg`).

## Commits

One conventional line, no body:

`feat: …` · `fix: …` · `docs: …` · `style: …` · `refactor: …` · `test: …` · `chore: …`

Optional scope: `fix(sync): …`.

## License

By contributing you agree that your work is licensed under [AGPL-3.0-or-later](LICENSE), the same as the rest of the project.
