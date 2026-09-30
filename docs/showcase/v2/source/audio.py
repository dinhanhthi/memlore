#!/usr/bin/env python3
"""Soundtrack for a showcase film, derived from its timeline.

    python3 audio.py --timeline timeline.json --out audio.wav [--lufs -16]

timeline.json comes from `node capture.mjs --mode timeline` and looks like
{"duration": 30, "fps": 60, "timeline": [{"scene", "start", "dur", "opts"}]}.

Cues:
- whoosh just before every scene start after the first (the shared transition)
- pop at every scene start
- opts.events = [{"t": 1.2, "kind": "pop|click|tick|chord"}], t in seconds LOCAL to the scene start
- a final chord at the last scene start (the end card)
plus a soft pad bed following a chord progression.

Loudness: the gain targets --lufs with an RMS approximation (no K-weighting, no gating).
The real check is ffmpeg's ebur128 filter (scripts/verify-video.sh in the skill folder).
Needs python3 + numpy only.
"""
import argparse
import json
import sys
import wave

import numpy as np

SR = 48000
rng = np.random.default_rng(3)  # seeded: same timeline, same file


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--timeline", required=True, help="timeline.json from capture.mjs --mode timeline")
    p.add_argument("--out", default="audio.wav")
    p.add_argument("--lufs", type=float, default=-16.0, help="target integrated loudness (approx), -14..-20")
    return p.parse_args()


# ---------- synthesis helpers ----------
def env(n, a=0.002, d=0.2):
    t = np.arange(n) / SR
    return np.minimum(t / a, 1) * np.exp(-t / d)


def lowpass(x, a):
    """One-pole low-pass; only used on short cues (a per-sample loop)."""
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):
        acc += a * (x[k] - acc)
        y[k] = acc
    return y


def tone(f, dur, dec, g=1.0, harm=(1, 0.4, 0.15), a=0.004):
    n = int(SR * dur)
    t = np.arange(n) / SR
    return sum(h * np.sin(2 * np.pi * f * (i + 1) * t) for i, h in enumerate(harm)) * env(n, a, dec) * g


def pop(g=0.4, f0=500, f1=1100):
    n = int(SR * 0.12)
    t = np.arange(n) / SR
    f = f0 + (f1 - f0) * np.minimum(t / 0.05, 1)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.002, 0.04) * g


def click(g=0.5):
    n = int(SR * 0.025)
    x = rng.standard_normal(n)
    x = x - lowpass(x, 0.2)
    return x * env(n, 0.0003, 0.005) * g


def tick(g=0.05):
    return tone(1500, 0.05, 0.015, g, (1,))


def whoosh(dur=0.6, g=0.5):
    n = int(SR * dur)
    x = rng.standard_normal(n)
    tt = np.linspace(0, 1, n)
    out = np.empty(n)
    acc = 0.0
    for k in range(n):
        acc += (0.01 + 0.2 * tt[k]) * (x[k] - acc)
        out[k] = acc
    return out * np.sin(np.pi * tt) ** 2 * 3 * g


def chord(freqs, dur=3.0, g=0.12):
    return sum(tone(f, dur, dur * 0.4, g, (1, 0.35, 0.1), a=0.02) for f in freqs)


def pad(freqs, dur, g):
    n = int(SR * dur)
    t = np.arange(n) / SR
    e = np.minimum(t / 0.4, 1) * np.clip(np.minimum((dur - t) / 0.5, 1), 0, 1)
    s = sum(np.sin(2 * np.pi * f * t + 0.3 * np.sin(2 * np.pi * 0.4 * t)) + 0.3 * np.sin(2 * np.pi * 2 * f * t) for f in freqs)
    return s * e * g / len(freqs)


# ---------- mixing ----------
class Mix:
    def __init__(self, duration):
        self.n = int(SR * duration)
        self.L = np.zeros(self.n)
        self.R = np.zeros(self.n)

    def add(self, sig, t, g=1.0, pan=0.0):
        i = int(max(0.0, t) * SR)
        if i >= self.n:
            return
        j = min(self.n, i + len(sig))
        s = sig[: j - i] * g
        self.L[i:j] += s * min(1, 1 - pan)
        self.R[i:j] += s * min(1, 1 + pan)


def feedback_delay(x, delay_s, feedback):
    """y[n] = x[n] + feedback * y[n - d], vectorized in blocks of d samples."""
    d = int(SR * delay_s)
    y = x.copy()
    for k in range(d, len(y), d):
        end = min(len(y), k + d)
        y[k:end] += feedback * y[k - d : end - d]
    return y


def reverb(x, wet=0.18):
    taps = ((0.0297, 0.6), (0.0371, 0.55), (0.0411, 0.5), (0.0437, 0.45))
    tail = sum(feedback_delay(x, d, fb) for d, fb in taps) / len(taps) - x
    return x + tail * wet


def approx_lufs(L, R):
    """Ungated, un-weighted approximation of integrated loudness for a stereo pair."""
    power = np.mean(L ** 2) + np.mean(R ** 2)
    return -0.691 + 10 * np.log10(max(power, 1e-12))


def master(L, R, target, ceiling=0.95):
    fi, fo = int(SR * 0.02), min(len(L) // 2, int(SR * 1.2))
    fade = np.ones(len(L))
    fade[:fi] = np.linspace(0, 1, fi)
    fade[len(L) - fo :] = np.linspace(1, 0, fo)
    L, R = L * fade, R * fade
    for _ in range(3):  # gain to target, soft-limit, repeat (the limiter lowers loudness a little)
        g = 10 ** ((target - approx_lufs(L, R)) / 20)
        L = ceiling * np.tanh(L * g / ceiling)
        R = ceiling * np.tanh(R * g / ceiling)
    return L, R


# ---------- score ----------
# Progression I - V - vi - IV in C (pads), bass an octave below the root.
CHORDS = [(261.6, 329.6, 392.0), (196.0, 246.9, 293.7), (220.0, 261.6, 329.6), (174.6, 220.0, 261.6)]
BASS = [65.4, 49.0, 55.0, 43.65]
FINAL = (130.8, 196.0, 261.6, 329.6, 392.0, 523.3)
BAR = 2.4  # seconds per chord (100 bpm, 4 beats)


def score(data):
    timeline = sorted(data.get("timeline", []), key=lambda e: e["start"])
    if not timeline:
        sys.exit("audio.py: timeline is empty")
    duration = float(data.get("duration") or max(e["start"] + e["dur"] for e in timeline))
    mix = Mix(duration)
    last = timeline[-1]["start"]

    # music bed until the end card, then the final chord rings out
    t, bar = 0.0, 0
    bed_end = last + 0.2 if len(timeline) > 1 else duration
    while t < bed_end - 0.05:
        dur = min(BAR, bed_end - t) + 0.3
        mix.add(pad(CHORDS[bar % 4], dur, 0.16), t)
        mix.add(tone(BASS[bar % 4] * 2, dur, dur * 0.5, 0.12, (1, 0.5, 0.2), a=0.05), t)
        t += BAR
        bar += 1

    for i, e in enumerate(timeline):
        start = e["start"]
        if i > 0:
            mix.add(whoosh(0.6, 0.45), start - 0.15)
        mix.add(pop(0.35, 420, 900), start)
        for ev in (e.get("opts") or {}).get("events", []):
            at, kind = start + float(ev.get("t", 0)), ev.get("kind", "pop")
            if kind == "click":
                mix.add(click(0.6), at)
            elif kind == "tick":
                mix.add(tick(), at, pan=0.2)
            elif kind == "chord":
                mix.add(chord(CHORDS[0], 1.2, 0.08), at)
            else:
                mix.add(pop(0.35), at)
    mix.add(chord(FINAL, max(1.0, duration - last), 0.12), last)
    return mix


def write_wav(path, L, R):
    st = (np.stack([L, R], 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(st.tobytes())


def main():
    args = parse_args()
    with open(args.timeline, encoding="utf-8") as f:
        data = json.load(f)
    mix = score(data)
    L, R = master(reverb(mix.L), reverb(mix.R), args.lufs)
    write_wav(args.out, L, R)
    print(f"audio: {len(L) / SR:.2f}s, approx {approx_lufs(L, R):.1f} LUFS (check with ebur128) -> {args.out}")


if __name__ == "__main__":
    main()
