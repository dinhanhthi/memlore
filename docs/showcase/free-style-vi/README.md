# Memlore free-style showcase, Vietnamese fork

The same product film as `docs/showcase/free-style/`, with a Vietnamese voice-over (Quang Toan),
Vietnamese on-screen text and Vietnamese app screenshots. It renders to
`docs/showcase/free-style-showcase.vi.mp4` (gitignored). Length today: 264.0 s.

## Why a fork

Another process renders the English film from `docs/showcase/free-style/` and may change it at any
time. This folder is a separate copy of the engine taken from the reviewed v4 state (`film.js`,
`lib.js`, `scenes/`, `timing.js`, `fit.mjs`, `mix.mjs`, `music.mjs`, `render.mjs`, ...), so nothing
here can break or be broken by the English render. It shares only the read-only `../assets/` folder
(fonts, logos, stickers, icons, map, photos) and reads the user's script
`../free-style/narration.vi.json`. The English folder is never written from here.

## Where to edit

Only two files are meant to be edited by hand:

| What | File |
| --- | --- |
| What is spoken, and each scene title | `docs/showcase/free-style/narration.vi.json` |
| Every other on-screen text, and the cue phrases | `docs/showcase/free-style-vi/texts.vi.json` |

`texts.vi.json` is a JSON object of `<scene>.<key>` strings (nested keys are dotted paths, for
example `themes.layout.left.name`). A `{name}` inside a string is a placeholder the scene fills in
(a count, a year, a name); keep it as it is. Do not hard-code text in `scenes/*.js`.

The `cue` block of each scene holds the timing phrases: `<scene>.cue.<key>` is a word or short
phrase that appears in the spoken line, and the picture element tied to that key appears when the
voice says it. Matching is the `cue()` function in `lib.js`: the phrase is split on spaces, each word
is lower-cased and stripped of punctuation (Latin letters, digits, Vietnamese letters with marks and
apostrophes are kept), and the words must appear in a row in the spoken line. Case and punctuation are
ignored, but accents are not stripped: write the phrase with the same accents as the spoken text.
Each scene searches one voice line (the first, except the Daily Chat card of `aiCards`, line 8).

On a miss nothing crashes: the beat falls back to the start of the voice line, so it lands too early.
`check-cues.mjs` and `stills.mjs` both report the miss. After changing a spoken line, re-check the cues.

`to-consider.md` (Vietnamese) is a list of wording that is long for its slot on screen, written while
checking the layout. It only records suggestions; nothing in it has been applied. Shorten a string
in `texts.vi.json` (or the narration) if you agree.

## Files

- `film.html`, `film.css`, `lib.js`, `film.js`, `scenes/*.js` - page and engine, copied from the v4 state.
  Every frame is a pure `render(t)`. Text comes from `texts.vi.json` through `T()` and `cueT()` in `lib.js`.
- `config.mjs` - the one place naming inputs, outputs and the voice. `film.js` mirrors the few paths it needs.
- `timeline.json` - this fork's own timing (written by `fit.mjs --write`); `timing.js`, `timing.test.mjs`,
  `timing-fixtures.json` - shared timing maths and its tests.
- `texts.vi.json` - on-screen text and cue phrases (edit).
- `voice.mjs` - Quang Toan voice generator. `voice-vi/` holds one mp3 + alignment json per spoken line,
  `manifest.json` (real word times) and `at.json` (line starts written by `fit.mjs`).
- `estimate-voice.mjs` - free stand-in that writes an estimated manifest (see below).
- `fit.mjs` - places the voice lines and sizes every scene to its speech.
- `check-cues.mjs` - checks every cue phrase against the real voice timing.
- `stills.mjs` - contact-sheet stills of every scene into `stills-out/` (open `stills-out/index.html`).
- `overflow-scan.mjs` - flags text that is clipped or outside its card or the frame.
- `capture.mjs` - re-captures the Vietnamese app screenshots into `../assets/shots/free-style-vi/`.
- `music-plan.json`, `music.mjs`, `mix.mjs`, `soundtrack.py`, `render.mjs` - score, mix and render, as in the English folder.
- `to-consider.md` - long-wording notes.

## Estimated manifest and the `--i-am-sure` guard

Before the real voice exists, `estimate-voice.mjs` writes `voice-vi/manifest.json` and `at.json` from
the text alone (14 characters per second, no audio, no credits). That manifest has `"estimated": true`;
`fit.mjs`, `mix.mjs` and `check-cues.mjs` refuse to run on it, and `voice.mjs` replaces it. A real
manifest is never overwritten by the estimator. The current manifest is the real one.

`voice.mjs` and `music.mjs` call the paid ElevenLabs API, so each refuses to run without `--i-am-sure`.
The key comes only from the `ELEVENLABS_API_KEY` environment variable; never commit or print it.

## Voice

`config.mjs` sets Quang Toan (`voice_id` ZsjEJaLQy3sgvwxicmDx), model `eleven_v4`, `language_code` vi,
tempo 1.12 (ffmpeg atempo on the cached raw mp3, pitch kept), stability 0.75, similarity 0.75, speaker
boost on (`eleven_v4` ignores `style`). The audition's stability 0.15 gave raspy takes and let lines drift
from the Southern accent into a Northern one, so do not lower it again.
The `voice` block in `narration.vi.json` is ignored. Each line is cached by hash in `voice-vi/`, so
only edited lines are billed again.

## Vietnamese app screenshots

`capture.mjs` drives the website demo with Playwright and saves 1440x900 @2x JPEGs to
`../assets/shots/free-style-vi/`. Start the demo in another terminal with `pnpm website:dev --port 5176`
(set `DEMO_URL` to use another address), then:

```bash
node docs/showcase/free-style-vi/capture.mjs              # all shots
node docs/showcase/free-style-vi/capture.mjs clay-dark    # only the named shots, comma separated
```

The language is seeded in two ways: an init script writes `memlore-ui` = `{ uiLanguage: 'vi' }` into
`localStorage`, and a route rewrites the demo seed `website/demo/scenario.ts` on the fly, because that
file forces `uiLanguage: "en"` and the app would apply it over the stored value. The rewrite is a regex
on `uiLanguage: "en"` in that file: if the demo seed changes shape, the shots silently come back in
English, so look at a couple of shots after any website change. The website source is never edited.

## After you edit: the command sequence

Commands run from the repo root. Steps 1, 2, 5 and 6 have already been run (5 and 6 on 2026-09-30).

1. DONE `ELEVENLABS_API_KEY=... node docs/showcase/free-style-vi/voice.mjs --i-am-sure`
   Generates the Quang Toan lines into `voice-vi/`. Re-run after editing a spoken line: only changed
   lines are billed (`--force` regenerates everything). Key via the environment only.
2. DONE `node docs/showcase/free-style-vi/fit.mjs`, then `node docs/showcase/free-style-vi/fit.mjs --write`
   The first prints the report, `--write` writes `voice-vi/at.json` and this fork's `timeline.json`
   (never `narration.vi.json`). Free. Re-run after any voice change.
3. `node docs/showcase/free-style-vi/check-cues.mjs`
   Free. Lists each cue phrase with the second it lands, or UNRESOLVED; exit 1 when anything is
   unresolved. Fix unresolved phrases in `texts.vi.json`. At the time of writing all 88 cues resolve.
4. `node docs/showcase/free-style-vi/stills.mjs` and `node docs/showcase/free-style-vi/overflow-scan.mjs`
   Free. Re-check after any text edit; open `docs/showcase/free-style-vi/stills-out/index.html`.
   Both accept `--scene a,b`; `stills.mjs` also `--out <dir>`; `overflow-scan.mjs` also `--all`.
5. DONE (2026-09-30) `ELEVENLABS_API_KEY=... node docs/showcase/free-style-vi/music.mjs --i-am-sure`
   One score generation for the Vietnamese timeline. Costs ElevenLabs credits (`--dry` prints the
   request without a call, `--test` makes one 10 s call). Cached by request hash, so a changed timeline
   costs again. Run it only after the texts and voice are final (fit changes the timeline).
6. DONE (2026-09-30) `node docs/showcase/free-style-vi/render.mjs` -> `docs/showcase/free-style-showcase.vi.mp4`
   Output `docs/showcase/free-style-showcase.vi.mp4`, film length 264.0 s.
   About 10 minutes. It re-runs `mix.mjs` itself (which stops if `music/music.mp3` is missing or stale).
   Faster checks: `render.mjs --stills 40,72.5` and `render.mjs --preview 56 68`.
   Re-rendering rule: before every re-render, move the existing output into `docs/showcase/free-style-video-archived/` under the next free version name (`free-style-showcase.vi.v2.mp4`, `.vi.v3.mp4`, ...; `.vi.v1.mp4` is already there) and never let a render overwrite an existing mp4. Do it only while no `render.mjs`/`ffmpeg` process is running: ffmpeg writes straight into the output file, so moving it mid-render corrupts both files.

## Known limits

- The demo journal text inside the screenshots is English (it is seed data in the website demo); only the app UI is Vietnamese.
- This is a copy: later fixes to the engine in `docs/showcase/free-style/` are not picked up here; port them by hand.
- Fraunces italic has no Vietnamese subset, so italic display text falls back to another face for accented letters.
- There is no review app in this fork (`review/` is not copied).
- The score's final chord rings out by about 261 s, so the last ~3 s are near-silent; mix.mjs therefore uses a relaxed -60 dBFS dropout threshold for the last 3 s of the film (TAIL), up to the start of the fade (mix.mjs checks windows up to DUR - FADE) and keeps -40 dBFS for the rest of the film.
