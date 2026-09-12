# Memlore website

Dark-only marketing site and interactive demo. The landing page lives in
`index.html`; the demo is a same-origin `demo.html` iframe that mounts the
real `src/App.tsx` with a website-only fake backend. App styles and state
do not leak into the landing page.

**Production preview is the verification source of truth.** Do not treat
`website:dev` as a production check. Hashed `/assets/` URLs, iframe theme
sync, and overflow only count when they come from `website:build` +
`website:preview`.

## Commands

From the repository root, with root dependencies installed:

```sh
pnpm website:dev       # Vite dev server — http://localhost:5176
pnpm website:build     # typecheck + production bundle → website/dist/
pnpm website:preview   # serve the built assets — http://localhost:4176
pnpm website:test      # Vitest (jsdom) — backend, bridge, content, streaming
```

Playwright against the **built** preview (builds first, then serves port 4176):

```sh
pnpm exec playwright test --config website/playwright.config.ts
```

This is a separate config from the root web-harness suite on port 5175.
Chromium is enough. If browsers are missing:

```sh
pnpm exec playwright install chromium
```

Screenshots land in `website/test-results/` (gitignored).

## What the demo is

The demo is a **simulated workflow**. It does not call a real AI provider,
does not talk to Google Drive or iCloud, does not collect credentials, and
does not read or write the real filesystem. Journal entries, locks, sync,
export/import, and chat replies are fake, in-memory, and labelled as such
on the landing page.

The unlock / second-lock password in the demo is `memlore`. It is a sample
credential for the mock, not a real journal password.

## Demo poster

The demo is the full app (3.9 MB parsed, ~1.5 MB over the wire, same origin,
same main thread), so the
landing page does not mount the iframe until **Start the demo** is clicked.
Until then it shows `src/demoPoster.webp`: a Playwright screenshot of
`demo.html` at 1280×700 (Clay dark, the seeded default), pre-blurred with
`magick in.png -blur 0x3 out.png` and encoded with `cwebp -q 75`. Regenerate it
after visible changes to the seeded entry or the app chrome.

## Reset and reload

- **Reset demo** on the landing page reloads the iframe. That creates a new
  isolated in-memory backend, editor, and chat session, and returns the
  guided tour to **Write a little**.
- Reloading the landing page or `demo.html` does the same: a fresh seed.
- The demo does not clear host `localStorage` outside its own in-memory
  namespace. Closing the tab is enough to drop the session.

## Known limitations

- The iframe is a desktop-width app (`min-width: 1024px`) inside a
  horizontally scrollable viewport. On a phone, use **Open separately**.
- Chat **New** / **Send** are enabled because the demo seeds a local Ollama
  slot (`addedProviders: ['ollama']`). Replies stream from a timer, not a
  model. Full token-contract coverage is in `website/tests/scenario.test.ts`
  and `website/tests/streaming.test.ts`. Playwright only asserts that
  sending a message starts the stream (Stop appears). Completing every
  token in the iframe is timing-fragile.
- Entry create / edit / favorite / delete persistence is in-session only.
  Covered by `website/tests/backend.test.ts`. A full TipTap edit-and-return
  Playwright walkthrough is not part of the smoke suite.
- Sync, export, import, and some system settings show an explicit
  “simulated” notice instead of silently doing nothing.
- There is no production binary or store listing. The **Download beta**
  control opens https://github.com/dinhanhthi/memlore. Doc is a coming-soon
  disclosure, not a 404 link.
- macOS is the current platform. Windows, Linux, iOS, and Android are
  coming soon without a date.

## Layout

| Path                            | Role                                              |
| ------------------------------- | ------------------------------------------------- |
| `src/LandingPage.tsx`           | Marketing page                                    |
| `src/content.ts`                | English copy                                      |
| `src/demoBridge.ts`             | Parent → iframe commands (theme, navigate, reset) |
| `demo/`                         | Fake backend, streaming, Tauri aliases, bootstrap |
| `tokens.css` / `src/styles.css` | Dark-only Hallmark Workbench tokens               |
| `tests/landing.spec.ts`         | Production-preview Playwright smoke               |
| `playwright.config.ts`          | Website-only Playwright (port 4176)               |
