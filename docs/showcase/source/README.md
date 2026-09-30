# Memlore showcase film — source

A 52-second product film in two language cuts, rendered from code:

| Output | Language | Command |
| --- | --- | --- |
| `docs/showcase/memlore-intro.mp4` | English | `node docs/showcase/source/render.mjs` |
| `docs/showcase/memlore-intro-vi.mp4` | Vietnamese | `node docs/showcase/source/render.mjs vi` |

Both are 1920×1080, 60 fps, H.264 + AAC. Commands run from the repo root.

## How it works

- **`memlore.html`** draws every frame on a `<canvas>` from a pure `render(t)` (same `t` gives the same frame). It adds motion blur by averaging sub-frames and never blurs across a hard cut. `?lang=vi` selects the Vietnamese cut. Without it you get English. Open it in a browser (through any local static server) for a live, unblurred preview.
- **All on-screen text** lives in the `STR` table near the top of `memlore.html`, one block per language. Change wording there. Timing and layout are shared by both cuts.
- **`render.mjs`** serves `docs/showcase/` (this film plus the shared `../assets/`) on localhost, steps `t` frame by frame in headless Chromium (`@playwright/test`), and pipes PNG frames plus `soundtrack.wav` into ffmpeg. Pass a comma-separated list of times as the second argument (for example `render.mjs vi 12.5,30`) to write inspection stills to `stills/` instead of a video.
- **`soundtrack.py`** synthesizes the 120 BPM score, locked to the film's cut times, into `soundtrack.wav`. Both cuts share it.

## Regenerating everything

```bash
python3 docs/showcase/source/soundtrack.py     # soundtrack.wav (needs numpy + scipy)
node docs/showcase/source/render.mjs           # English  (~6 min)
node docs/showcase/source/render.mjs vi        # Vietnamese
```

Needs `ffmpeg` on the PATH and the Playwright Chromium the repo already uses (`pnpm exec playwright install chromium`).

## Assets

All assets live in the shared `docs/showcase/assets/` folder, used by every showcase film:

- `assets/shots/source/*.jpg`: English-UI screenshots. `assets/shots/source/vi/*.jpg`: the same screens with the Vietnamese UI. These come from the website demo, whose sample journal content is English in both.
- `assets/logo.png`, `assets/appicon.png`, `assets/stickers/sticker-*.png`: copies from `public/`. The film refers to stickers as `st-<name>`, which `load()` in `memlore.html` maps to `stickers/sticker-<name>.png`.
- `assets/land.js`: Natural Earth 110m land path (public domain), extracted from `website/src/naturalEarthLand.ts`.
- `assets/fonts/`: Fraunces, Geist and Geist Mono (latin + vietnamese subsets) from the app's `@fontsource-variable` packages.

To refresh them after UI changes:

```bash
pnpm website:dev                                 # demo on :5176, in another terminal
node docs/showcase/source/capture.mjs            # assets/shots/source/*.jpg
node docs/showcase/source/capture.mjs vi         # assets/shots/source/vi/*.jpg
node docs/showcase/source/copy-fonts.mjs         # assets/fonts/
```

The film crops and zooms into fixed CSS coordinates of these 1440×900 screenshots, for example the search results rows and the gallery tiles used on the map pins. If a screen's layout moves, re-check those scenes with stills.
