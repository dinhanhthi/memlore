"""Synthesize the free-style film's score into soundtrack.wav.

    python3 docs/showcase/free-style/soundtrack.py [--timeline PATH] [--out PATH]
    python3 docs/showcase/free-style/soundtrack.py --selftest
    python3 docs/showcase/free-style/soundtrack.py --stem sfx --out docs/showcase/free-style/sfx.wav

--stem sfx keeps only the cut accents (whooshes, impacts, the intro riser, drum hits, and the short high
sparkle chimes) and drops the harmony and melody, so it sits over a score in another key
(mix.mjs layers it over the ElevenLabs music). The default --stem full is the complete synthesized score.

An original, upbeat 120 BPM track (C major: C–G–Am–F), locked to timeline.json so every
scene cut lands on a beat. Each scene's "section" picks the arrangement:
intro / build / verse / chorus / bridge / outro. Scene timing (speed / warp / beats /
snap) follows timing.js, ported below; --selftest checks the port against
timing-fixtures.json and exits without synthesizing. Needs numpy + scipy.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description="Synthesize the free-style soundtrack.")
ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
ap.add_argument("--out", default=os.path.join(HERE, "soundtrack.wav"))
ap.add_argument("--selftest", action="store_true", help="check the timing port against timing-fixtures.json")
ap.add_argument("--stem", choices=["full", "sfx"], default="full", help="full score, or only the unpitched cut accents")
ARGS = ap.parse_args()
SFX = ARGS.stem == "sfx"


# ── timing: 1:1 port of timing.js sceneMap (JS Math.round = floor(x + 0.5)) ──
def js_round(x):
    return math.floor(x + 0.5)


def scene_map(scene, bpm=120):
    """A scene's srcDur / rawOutDur / outDur plus to_source / to_output (scene-local seconds)."""
    beat_len, bar_len = 60 / bpm, 4 * 60 / bpm
    src_dur = scene["bars"] * bar_len
    speed = scene.get("speed")
    speed = 1 if speed is None else speed
    warp = scene.get("warp") or []

    def out_dur_of(raw):
        if scene.get("beats") is not None:
            return scene["beats"] * beat_len
        if scene.get("snap") == "bar":
            return max(1, js_round(raw / bar_len)) * bar_len
        return max(1, js_round(raw / beat_len)) * beat_len

    if speed == 1 and not warp:
        ident = lambda t: t  # noqa: E731
        return {"srcDur": src_dur, "rawOutDur": src_dur, "outDur": out_dur_of(src_dur), "to_source": ident, "to_output": ident}

    # segments covering [0, srcDur]: gaps at base speed, ranges at their own speed
    segs, pos = [], [0.0, 0.0]  # source, output cursors

    def push(to, v):
        if to > pos[0]:
            segs.append((pos[0], to, pos[1], v))  # s0, s1, o0, v
            pos[1] += (to - pos[0]) / v
            pos[0] = to

    for r in warp:
        push(r["from"], speed)
        push(r["to"], r["speed"])
    push(src_dur, speed)
    raw_out = pos[1]

    # outside [0, srcDur] both maps extrapolate at base speed
    def to_source(o):
        if o < 0:
            return o * speed
        if o > raw_out:
            return src_dur + (o - raw_out) * speed
        g = segs[0]
        for x in segs:
            if o >= x[2]:
                g = x
            else:
                break
        return min(g[1], g[0] + (o - g[2]) * g[3])

    def to_output(t):
        if t < 0:
            return t / speed
        if t > src_dur:
            return raw_out + (t - src_dur) / speed
        g = segs[0]
        for x in segs:
            if t >= x[0]:
                g = x
            else:
                break
        return g[2] + (t - g[0]) / g[3]

    return {"srcDur": src_dur, "rawOutDur": raw_out, "outDur": out_dur_of(raw_out), "to_source": to_source, "to_output": to_output}


def selftest():
    cases = json.load(open(os.path.join(HERE, "timing-fixtures.json")))["sceneMap"]
    passed, failed = 0, []
    for c in cases:
        m, e = scene_map(c["scene"], c.get("bpm", 120)), c["expect"]
        ok = all(abs(m[k] - e[k]) < 1e-9 for k in ("srcDur", "rawOutDur", "outDur"))
        ok = ok and all(abs(m["to_source"](o) - src) < 1e-9 and abs(m["to_output"](src) - o) < 1e-9 for o, src in e["points"])
        if ok:
            passed += 1
        else:
            failed.append(c["name"])
    print(f"selftest: {passed}/{len(cases)} sceneMap cases pass" + (f"; failed: {', '.join(failed)}" if failed else ""))
    return not failed


if ARGS.selftest:
    sys.exit(0 if selftest() else 1)

TL = json.load(open(ARGS.timeline))
BPM = TL.get("bpm") or 120
BEAT = 60 / BPM
BAR = 4 * BEAT

# scene start times (output), per-scene warp maps, bar → section of the scene active at its start
cuts, maps = [], {}
t = 0.0
for s in TL["scenes"]:
    m = scene_map(s, BPM)
    cuts.append((t, s["id"], s["section"]))
    maps[s["id"]] = (t, m["to_output"])
    t += m["outDur"]
DUR = t
N = int(DUR * SR) + SR * 2
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)
NBARS = math.ceil(DUR / BAR - 1e-9)
sections = [next((c[2] for c in reversed(cuts) if c[0] <= b * BAR + 1e-9), cuts[0][2]) for b in range(NBARS)]


def at(sid, lt):
    """Output time of scene-local source time lt in scene sid."""
    start, to_output = maps[sid]
    return start + to_output(lt)


def outro_click():
    """Scene-local time of the outro's download click: finale.js puts it at voEnd(c, 0, 5.1) + 0.15,
    the end of the outro voice line (voice-vi/at.json + manifest.json, mirrored like film.js)."""
    try:
        with open(os.path.join(HERE, "voice-vi", "at.json")) as f:
            ats = json.load(f).get("outro")
        with open(os.path.join(HERE, "voice-vi", "manifest.json")) as f:
            lines = json.load(f)["lines"].get("outro") or []
    except (OSError, KeyError, ValueError):
        ats, lines = None, []
    first = ats[0] if isinstance(ats, list) else ats
    return (first + lines[0]["dur"] if lines and first is not None else 5.1) + 0.15


CLICK = outro_click()
# final ringing chord on the outro's download click, but always at least 3 s
# before the end; snapped to a beat so a warped outro still lands the chord on the grid.
# The groove plays up to it; the chord then rings to the very last sample (see below).
END_CHORD_T = js_round(min(at("outro", CLICK), DUR - 3.0) / BEAT) * BEAT


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a=0.005, d=0.2, s=0.0, r=0.05, hold=None):
    """ADSR-ish envelope of n samples."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    if hold is None:
        e = e * np.exp(-np.maximum(0, t - a) / max(d, 1e-4)) * (1 - s) + s * (t >= a) * np.minimum(1, t / max(a, 1e-4))
    else:
        e = np.where(t < hold, e * (s + (1 - s) * np.exp(-np.maximum(0, t - a) / d)), 0)
        rel = (t >= hold) * (s + (1 - s) * np.exp(-(hold - a) / d)) * np.exp(-(t - hold) / r)
        e = e + rel
    return e


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    lg, rg = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i : i + len(sig)] += sig * gain * lg * 1.41
    R[i : i + len(sig)] += sig * gain * rg * 1.41


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 - 100), "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


# ── instruments ──
def kick(g=1.0):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = rng.standard_normal(n) * np.exp(-t * 400) * 0.3
    return np.tanh((body + click) * 1.6) * g


def clap(g=1.0):
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 5000)
    e = np.exp(-t * 18) + 0.6 * np.exp(-np.maximum(0, t - 0.012) * 30) * (t > 0.012) + 0.5 * np.exp(-np.maximum(0, t - 0.024) * 30) * (t > 0.024)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.4
    return (noise * e * 0.8 + tone) * g


def hat(open_=False, g=1.0):
    n = int((0.22 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t * (14 if open_ else 90)) * g


def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    out = 2 * ((t * f) % 1) - 1
    if detune:
        out = 0.5 * out + 0.5 * (2 * ((t * f * (1 + detune)) % 1) - 1)
    return out


def bass(note, dur, g=1.0):
    n = int(dur * SR)
    f = midi(note)
    t = np.arange(n) / SR
    x = saw(f, n) * 0.6 + np.sin(2 * np.pi * f * t) * 0.8
    x = lp(x, 900) * env(n, 0.004, 0.18, 0.55, 0.04, hold=dur * 0.85)
    return np.tanh(x * 1.3) * g


def pluck(notes, dur, g=1.0, bright=3500):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in notes:
        f = midi(k)
        x += saw(f, n, 0.004) * 0.5 + np.sin(2 * np.pi * f * 2 * t) * 0.15
    x = lp(x, bright) * np.exp(-t * 9)
    return x * g / max(1, len(notes)) * 1.6


def bell(note, dur=0.9, g=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(note)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 1.8 * np.exp(-t * 6)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 3.8) + 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t * 7)
    return x * np.minimum(1, t / 0.003) * g


def pad(notes, dur, g=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in notes:
        f = midi(k)
        x += saw(f, n, 0.006) + 0.6 * saw(f * 0.5, n, 0.003)
    x = lp(x, 1400) / max(1, len(notes))
    e = np.minimum(1, t / 0.5) * np.minimum(1, (dur - t) / 0.6)
    return x * np.clip(e, 0, 1) * g


def whoosh(dur=0.6, g=1.0, up=True):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    seg = 512
    for i in range(0, n, seg):
        p = i / n if up else 1 - i / n
        fc = 300 + 5000 * p ** 2
        blk = noise[max(0, i - 2048) : i + seg]
        out[i : i + seg] = bp(blk, fc * 0.7, fc * 1.3, 1)[-min(seg, n - i) :]
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    return out * e * g


def impact(g=1.0):
    n = int(1.8 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (38 + 60 * np.exp(-t * 10)) * t) * np.exp(-t * 2.6)
    crash = hp(rng.standard_normal(n), 3500) * np.exp(-t * 2.2) * 0.35
    return np.tanh((boom * 1.2 + crash) * 1.3) * g


def riser(dur, g=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = whoosh(dur, 1.0, up=True) * (t / dur) ** 1.5
    tone = np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / dur) ** 2) / SR) * (t / dur) ** 2 * 0.15
    return (x + tone) * g


def sparkle(g=1.0):
    n = int(0.6 * SR)
    out = np.zeros(n)
    for k in range(6):
        b = bell(96 + [0, 4, 7, 12, 16, 19][k], 0.4, 0.25)
        i = int(k * 0.05 * SR)
        out[i : i + len(b)] += b[: n - i]
    return out * g


# ── harmony ──
# C  G  Am F  (bridge: Am F C G)
PROG = [[48, 52, 55], [43, 47, 50], [45, 48, 52], [41, 45, 48]]
PROG_BRIDGE = [[45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50]]
# chorus lead motif over 4 bars (8th-note grid, None = rest), C major pentatonic
LEAD = [
    [76, None, 79, 81, 79, None, 76, 74],
    [74, None, 79, None, 83, 81, 79, None],
    [76, None, 72, 76, 81, None, 79, 76],
    [77, None, 76, 74, 72, None, 74, None],
]
ARP = [0, 12, 7, 12, 4, 12, 7, 16]

def add_bar(sig, at, gain=1.0, pan=0.0):
    """add() for the bar loop: events at/after the end chord are dropped."""
    if at < END_CHORD_T - 1e-9:
        add(sig, at, gain, pan)


for b in range(0 if SFX else NBARS):
    sec = sections[b]
    t0 = b * BAR
    chord = (PROG_BRIDGE if sec == "bridge" else PROG)[b % 4]
    root = chord[0] - 12
    last_of_section = b + 1 < NBARS and sections[b + 1] != sec
    if t0 >= END_CHORD_T - 1e-9:  # bars from the end chord on stay silent
        continue


    # pad everywhere except the busiest parts
    big = sec in ("chorus", "outro")
    if sec in ("intro", "bridge", "build", "outro"):
        add_bar(pad([n + 12 for n in chord], BAR + 0.3, 0.12 if sec != "build" else 0.08), t0, pan=0)
    if sec == "chorus":  # wide high pad only in the chorus, for lift
        add_bar(pad([n + 24 for n in chord], BAR + 0.3, 0.09), t0, pan=-0.4)
        add_bar(pad([n + 19 for n in chord], BAR + 0.3, 0.06), t0, pan=0.4)

    # drums
    if sec in ("verse", "chorus", "outro"):
        for q in range(4):
            add_bar(kick(0.8 if big else 0.6), t0 + q * BEAT)
        for q in (1, 3):
            add_bar(clap(0.48 if big else 0.34), t0 + q * BEAT, pan=0.05)
        for e8 in range(8):
            add_bar(hat(False, (0.06 if e8 % 2 == 0 else 0.1) * (1.2 if big else 0.8)), t0 + e8 * BEAT / 2, pan=0.3)
        if sec == "chorus":
            for q in range(4):
                add_bar(hat(True, 0.08), t0 + q * BEAT + BEAT / 2, pan=-0.3)
    elif sec == "bridge":
        add_bar(kick(0.7), t0)
        add_bar(kick(0.5), t0 + 2.5 * BEAT)
        add_bar(clap(0.3), t0 + 2 * BEAT)
        for e8 in range(8):
            add_bar(hat(False, 0.07), t0 + e8 * BEAT / 2, pan=0.3)
    elif sec == "build":
        # snare roll accelerating into the next section
        hits = 8 if not last_of_section else 16
        for k in range(hits):
            add_bar(clap(0.15 + 0.35 * k / hits), t0 + k * BAR / hits, pan=0)
        add_bar(kick(0.8), t0)
        add_bar(kick(0.8), t0 + 2 * BEAT)
    elif sec == "intro" and b >= 2:
        for e8 in range(8):
            add_bar(hat(False, 0.06), t0 + e8 * BEAT / 2, pan=0.3)

    # bass
    if sec in ("verse", "chorus", "outro", "build"):
        if sec == "chorus" or sec == "outro":
            for e8 in range(8):
                add_bar(bass(root + (12 if e8 % 2 else 0), BEAT / 2 * 0.9, 0.4), t0 + e8 * BEAT / 2)
        else:
            for q in range(4):
                add_bar(bass(root, BEAT * 0.8, 0.28), t0 + q * BEAT)
    elif sec == "bridge":
        add_bar(bass(root, BAR * 0.95, 0.26), t0)

    # chord stabs on the off-beats
    if sec in ("verse", "chorus", "outro"):
        for q in range(4):
            add_bar(pluck([n + 12 for n in chord], BEAT * 0.6, 0.34 if big else 0.2, 4500 if big else 2600), t0 + q * BEAT + BEAT / 2, pan=-0.2)

    # arpeggio sparkle in intro/build/verse
    if sec in ("intro", "build", "bridge") or (sec == "verse" and b % 2 == 1):
        for s16 in range(16 if sec == "build" else 8):
            step = BAR / (16 if sec == "build" else 8)
            note = chord[0] + 24 + ARP[s16 % 8]
            g = 0.1 if sec != "build" else 0.06 + 0.1 * s16 / 16
            add_bar(bell(note, 0.35, g), t0 + s16 * step, pan=0.4 if s16 % 2 else -0.4)

    # lead melody in chorus + outro
    if sec in ("chorus", "outro"):
        for e8, note in enumerate(LEAD[b % 4]):
            if note is not None:
                add_bar(bell(note, 0.6, 0.34), t0 + e8 * BEAT / 2, pan=0.1)
                add_bar(bell(note - 12, 0.5, 0.12), t0 + e8 * BEAT / 2, pan=-0.1)

    # risers into chorus sections
    if last_of_section and sections[b + 1] == "chorus":
        add_bar(riser(BAR, 0.5), t0)

# ── scene cuts: whoosh into every cut, impacts at big moments ──
for i, (ct, sid, sec) in enumerate(cuts):
    if i == 0:
        continue
    add(whoosh(0.55, 0.35, up=True), ct - 0.45, pan=-0.2 if i % 2 else 0.2)
    if sec == "chorus" or sid in ("hook", "outro", "aiIntro", "secondYou"):
        add(impact(0.55 if sec == "chorus" else 0.4), ct)

# intro: shards sparkle + logo hit at 1.9 s, wordmark bell at 4.2 s
add(riser(1.8, 0.35), at("intro", 0.1))
add(impact(0.6), at("intro", 1.9))
add(sparkle(0.9), at("intro", 1.95))
add(sparkle(0.6), at("intro", 4.2))
for k, n in enumerate([] if SFX else [72, 76, 79, 84]):
    add(bell(n, 1.2, 0.18), at("intro", 4.2 + k * 0.09))

# hook: a hit on each word (Write / Remember / Reflect / Privately)
for k, chord in enumerate([[60, 64, 67], [55, 59, 62, 67], [57, 60, 64], [53, 57, 60, 65]]):
    hit = at("hook", k * 1.0)
    add(kick(1.0), hit)
    add(clap(0.5), hit)
    if not SFX:
        add(pluck(chord, 0.9, 0.5, 5000), hit)
        add(bell(chord[-1] + 12, 0.8, 0.2), hit)

# outro: download click + confetti burst + final chord that rings until the film ends
# the click hit sits exactly on the visual click; only the chord below snaps to the beat
add(impact(0.5), at("outro", CLICK))
add(kick(0.9), at("outro", CLICK))
add(sparkle(1.0), at("outro", CLICK))
if not SFX:
    end_chord_t = END_CHORD_T
    tail = DUR - end_chord_t + 0.7  # the pad's own release lands after the master fade
    add(pad([60, 64, 67, 72], tail, 0.2), end_chord_t)
    add(pad([48, 55, 60], tail, 0.12), end_chord_t, pan=0)
    click_t = at("outro", CLICK)
    add(pluck([48, 55, 60, 64, 67], 3.0, 0.6, 5000), click_t)
    for k, n in enumerate([72, 76, 79, 84, 88]):
        add(bell(n, 2.5, 0.2), click_t + k * 0.12)
    # a soft bell every bar keeps the tail moving to the last second
    k = 1
    while end_chord_t + k * BAR < DUR - 0.5:
        add(bell([84, 79, 76, 72][k % 4], 1.6, 0.1), end_chord_t + k * BAR, pan=0.3 if k % 2 else -0.3)
        k += 1

# ── master ──
mix = np.stack([L, R], axis=1)[: int(DUR * SR)]
mix = np.stack([lp(mix[:, 0], 14000), lp(mix[:, 1], 14000)], axis=1)
mix = np.tanh(mix * 0.9)
fade = int(1.4 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
mix /= np.max(np.abs(mix)) / 0.89  # peak ≈ -1 dBFS
wavfile.write(ARGS.out, SR, (mix * 32767).astype(np.int16))
print(f"{ARGS.out}: {DUR:.1f} s, {NBARS} bars")
