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
```

## Docs pages

`/docs/` is the English "How Memlore works" section. To add a page:

1. Add a row to `src/docs/manifest.ts` (slug, title, description, group, optional diagram name). The manifest drives the route, the canonical URL, the sitemap entry, and the Vite input.
2. Add a shell at `docs/<slug>.html` (overview is `docs/index.html`). Copy a sibling shell. Asset paths are `../`. Canonical is `https://memlore.app` plus the path from `docsPath`.
3. Write `src/docs/content/<slug>.md`. Frontmatter needs `title`, `description`, `updated`, and one `sources:` line of repo paths you actually read. Allowed markdown is headings, paragraphs, lists, `**bold**`, absolute `/docs/...` links, and the blocks below. No tables, images, code fences, or raw HTML.
4. Optional: add the SVG string in `src/docs/diagrams/<name>.ts` and register it in `src/docs/diagrams/index.ts`. Draw a `docs-diagram-wide` (720) and a `docs-diagram-narrow` (360) SVG. Colours are `currentColor` or tokens from `tokens.css`.

Blocks, each on its own line (keep a blank line after the opening line and before the closing `:::` so prettier leaves them alone):

- `:::diagram <name>` shows a registered SVG.
- `:::widget <name>` shows an interactive explainer from `src/docs/widgets/` (registered in `widgets/index.ts`). The prerendered HTML shows its `WIDGET_FALLBACK` diagram instead.
- `:::cards` … `:::` turns `- **Title** — text` lines into a tile grid.
- `:::details <summary>` … `:::` folds edge cases into a closed disclosure (not used on docs pages). It cannot hold `:::cards`.

Keep each page short, about 200–270 words: one intro sentence, the diagram or widget, then a few `##` sections of short bullets. Say each fact once, and skip recap sections. Docs pages do not use `:::details`; a caveat about what leaves the device, what is not encrypted, or what cannot be recovered goes in a bullet, not only in a widget state.

Every factual sentence has to be traceable to the code named in `sources:`. Do not contradict `src/legal/privacy.md`. If the code and the policy disagree, describe the code and leave the policy for a separate change.

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
  model.
- Entry create / edit / favorite / delete persistence is in-session only.
- Sync, export, import, and some system settings show an explicit
  “simulated” notice instead of silently doing nothing.
- There is no production binary or store listing. The **Download beta**
  control opens https://github.com/dinhanhthi/memlore. **Docs** opens
  `/docs/`.
- macOS is the current platform. Windows, Linux, iOS, and Android are
  coming soon without a date.

## Layout

| Path                            | Role                                              |
| ------------------------------- | ------------------------------------------------- |
| `src/LandingPage.tsx`           | Marketing page                                    |
| `privacy.html`                  | Public Privacy Policy page                        |
| `terms.html`                    | Public Terms of Service page                      |
| `src/legal/`                    | Shared LegalPage and privacy/terms Vite entries   |
| `src/legal/privacy.md`          | Privacy Policy copy (Markdown)                    |
| `src/legal/terms.md`            | Terms of Service copy (Markdown)                  |
| `src/links.ts`                  | Shared public URLs (GitHub)                       |
| `src/demoBridge.ts`             | Parent → iframe commands (theme, navigate, reset) |
| `demo/`                         | Fake backend, streaming, Tauri aliases, bootstrap |
| `tokens.css` / `src/styles.css` | Dark-only Hallmark Workbench tokens               |
| `docs/`                         | HTML shells for `/docs/` and `/docs/<slug>`       |
| `src/docs/`                     | Docs page, manifest, markdown, diagrams, widgets  |
