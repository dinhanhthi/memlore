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
