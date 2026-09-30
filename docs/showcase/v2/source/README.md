# Memlore intro film v2 — source

Everything in this folder re-renders `../memlore-intro.mp4`: a 120-second, cinematic product film. The film is one deterministic canvas function, `render(t)`, in `video.html`. All on-screen copy lives in `strings.js` (each claim carries its repo source in a comment); timing lives in `TIMELINE` in `video.html`; colors and fonts in `BRAND` (Signature `.dark` tokens from `src/styles/globals.css`, converted to hex).

Settings: length 120 s · 60 fps · 16:9 (1920×1080) · English only · SFX + pad bed from `audio.py`.

Run every command from this folder unless noted.

## Setup

```bash
npm install
```

`capture.mjs` drives the local Chrome (set `CHROME_PATH` if it is somewhere unusual). ffmpeg must be on `PATH`; audio needs python3 with numpy. Fonts (Fraunces, Geist, Geist Mono), images and the map come from the shared `docs/showcase/assets/` folder, so rendering needs no network.

## Scenes

| File | Scene |
| --- | --- |
| `scenes/kit.js` | Shared helpers: backdrop, cinematic text reveal, caption column, app window + camera |
| `scenes/cold-open.js` | Three serif lines out of the dark |
| `scenes/brand.js` | Logo, wordmark, tagline |
| `scenes/promise.js` | Private. / Offline. / Yours. with mascot stickers |
| `scenes/screen.js` | Real screenshot in a window with a slow camera (`opts.shot`: write, find, gallery, mood, chat, sync) |
| `scenes/atlas.js` | Stylised Locations map (the demo has no map tiles) with the demo's real pins |
| `scenes/orbit.js` | The 17 AI providers orbiting the app icon (template scene, restyled) |
| `scenes/mcp.js` | The six MCP tools |
| `scenes/locks.js` | Unlock screen + the three lock types |
| `scenes/designs.js` | Clay / Clean / Signature, light and dark |
| `scenes/finale.js` | End card |

The chapter buttons in the preview jump to each scene. The transition is one shared bloom dissolve (`drawTransition` in `video.html`, 0.9 s).

## Refresh the screenshots

The app screens in `docs/showcase/assets/shots/v2/` (1440×900 @2x) come from the website demo:

```bash
pnpm website:dev                          # repo root, serves the demo on :5176
node docs/showcase/v2/source/shoot.mjs    # repo root, writes docs/showcase/assets/shots/v2/*.jpg
```

The camera views and highlight rings in `scenes/screen.js` are CSS coordinates of those screens. If a layout moves, re-check the affected scenes with a contact sheet.

## Build and preview

The bundle goes to `bundle/` (git-ignored).

```bash
node inline-assets.mjs --src video.html --out bundle/video.html
open bundle/video.html
```

## Contact sheet

```bash
node capture.mjs --mode sheet --src bundle/video.html --lang en --frames 40 --out sheet-en.jpg
```

## Capture, audio, mux

```bash
node capture.mjs --mode video --src bundle/video.html --lang en --fps 60 --out memlore-intro.mp4
node capture.mjs --mode timeline --src bundle/video.html --out timeline.json
python3 audio.py --timeline timeline.json --out audio.wav
ffmpeg -i memlore-intro.mp4 -i audio.wav -map 0:v -map 1:a -c:v copy \
  -c:a aac -b:a 192k -shortest -movflags +faststart memlore-intro.muxed.mp4
mv memlore-intro.muxed.mp4 ../memlore-intro.mp4 && rm memlore-intro.mp4
```

Capture takes a while (7200 frames). Encoding is `-c:v libx264 -crf 19 -preset slow -pix_fmt yuv420p -movflags +faststart`. Audio cues come from `opts.events` in `TIMELINE`, so a retime there is picked up by re-exporting `timeline.json`.

## Verify

`verify-video.sh` lives in the cf-showcase skill folder of the Coding Friend install (`scripts/verify-video.sh`):

```bash
bash "<skill folder>/scripts/verify-video.sh" ../memlore-intro.mp4 --duration 120 --fps 60 --size 1920x1080 --max-mb 100
```

The size budget is 100 MB (GitHub rejects pushes above that). If the file passes it, re-encode with a higher CRF (22–26) instead of lowering resolution.

## Poster frame

```bash
ffmpeg -ss 119 -i ../memlore-intro.mp4 -frames:v 1 -q:v 2 ../memlore-intro-poster.jpg
```
