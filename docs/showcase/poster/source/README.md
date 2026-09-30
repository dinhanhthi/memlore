# Memlore poster — source

A 1200×630 social / README banner, English only.

| Output | What |
| --- | --- |
| `docs/showcase/poster/memlore-poster.png` | 2400×1260 PNG (rendered at 2×) |
| `docs/showcase/poster/memlore-poster.html` | Self-contained page the PNG is captured from |

## Regenerate

From `docs/showcase/poster/source/`:

```bash
npm install                                   # once
node inline-assets.mjs --src poster.html --out ../memlore-poster.html
node capture.mjs --mode poster --src ../memlore-poster.html --size 1200x630 --format png --lang en --out ../memlore-poster.png
```

Needs Node and a local Chrome (or `CHROME_PATH`).

## How it works

- **`poster.html`** is the poster: plain DOM/CSS, composed for 1200×630 only. Copy lives in the `STR` table and is set with `textContent`. Colours come from `website/tokens.css` (paper, ink, muted, rules, amber accent); type is the app's own Fraunces, Geist and Geist Mono.
- **`inline-assets.mjs`** embeds the fonts and images as data URIs, so headless Chrome can open the page over `file://` without cross-directory font loads failing.
- **`capture.mjs`** opens the inlined page, waits for `window.__showcase.ready`, checks the declared fonts loaded, and screenshots the frame.

## Assets

All from the shared `docs/showcase/assets/`: three editor screenshots of the same entry stacked back to front, `shots/v2/sig-write.jpg` (Signature dark), `shots/v2/clean-light.jpg` (Clean light) and `shots/v2/clay-dark.jpg` (Clay dark, on top), all website demo data; `logo-straight.png` (mascot, facing the viewer), `appicon.png`, and `fonts/`. Design-system names come from `src/locales/en/palette.json:272-274`.

## Copy sources

- "A little life. / A lasting story." — `README.md:4`, `website/src/LandingPage.tsx:1397-1400`
- Lead sentence — `website/src/LandingPage.tsx:1404-1405`
- Open source · Free — `website/src/LandingPage.tsx:1392-1394`
- On your device / works fully offline — `README.md:19`
- Your cloud: Google Drive, iCloud Drive, more coming — `website/src/LandingPage.tsx:1443-1445`, `README.md:25` ("with more services coming")
- AI optional: local, on-device, or your own key — `website/src/LandingPage.tsx:1453-1455`
- AGPLv3 — `website/src/LandingPage.tsx:1426`, `LICENSE`
- No account · Encrypted on your device · macOS today — `website/src/LandingPage.tsx:1419`
- memlore.app — `README.md:6`
