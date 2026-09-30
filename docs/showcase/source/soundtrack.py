# 52s warm soundtrack at 120 BPM, events locked to memlore.html's timeline.
# Shared by both language cuts. Writes soundtrack.wav next to this file.
#   python3 docs/showcase/source/soundtrack.py   (needs numpy + scipy)
import os, numpy as np, wave
from scipy.signal import lfilter

SR = 48000
T = 52.0
N = int(SR * T)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(5)

def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N or i < 0: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))

def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); return lfilter([1 - a], [1, -a], x)
def hp(x, fc): return x - lp(x, fc)
def sweep_lp(x, fcs):  # time-varying one-pole, chunked
    y = np.zeros_like(x); s = 0.0; B = 256
    for i in range(0, len(x), B):
        a = np.exp(-2 * np.pi * fcs[min(i, len(fcs) - 1)] / SR)
        seg, zi = lfilter([1 - a], [1, -a], x[i:i + B], zi=[s * a])
        y[i:i + B] = seg; s = seg[-1] if len(seg) else s
    return y

def kick(d=0.4, f0=110, f1=45):
    t = tt(d); f = f1 + (f0 - f1) * np.exp(-t * 30)
    return np.tanh(1.6 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9))
def shaker(d=0.07):
    t = tt(d); return hp(rng.standard_normal(len(t)), 6000) * np.exp(-t * 55) * np.minimum(1, t / 0.006)
def click(freq=2200, d=0.03):
    t = tt(d); return (np.sin(2 * np.pi * freq * t) * 0.5 + hp(rng.standard_normal(len(t)), 3000) * 0.5) * np.exp(-t * 180)
def key_tap():
    t = tt(0.05); return lp(rng.standard_normal(len(t)), 2500) * np.exp(-t * 120) + np.sin(2 * np.pi * 180 * t) * np.exp(-t * 90) * 0.4
def whoosh(d, up=True):
    t = tt(d); x = t / d; n = rng.standard_normal(len(t))
    fc = 250 + 5000 * (x ** 2 if up else (1 - x) ** 2)
    return sweep_lp(n, fc) * ((x ** 2.2) if up else (1 - x) ** 1.5)
def soft_boom(d=1.2):
    t = tt(d); f = 38 + 60 * np.exp(-t * 10)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.5)
def pluck(freq, d=0.6, bright=4000):
    t = tt(d)
    s = sum(np.sin(2 * np.pi * freq * k * t) * np.exp(-t * (3 + k * 2.5)) / k for k in range(1, 7))
    return lp(s, bright) * np.minimum(1, t / 0.003)
def bell(freq, d=2.5):
    t = tt(d)
    return (np.sin(2 * np.pi * freq * t) * np.exp(-t * 1.8) + 0.4 * np.sin(2 * np.pi * freq * 2.76 * t) * np.exp(-t * 4)
            + 0.2 * np.sin(2 * np.pi * freq * 5.4 * t) * np.exp(-t * 7)) * np.minimum(1, t / 0.002)
def pad(freqs, d, att=0.8, rel=1.0, fc=1400):
    t = tt(d); s = np.zeros(len(t))
    for f in freqs:
        for det in (-0.004, 0, 0.004):
            ph = rng.uniform(0, 1)
            s += 2 * (((f * (1 + det)) * t + ph) % 1) - 1
    s = lp(lp(s / (len(freqs) * 3), fc), fc)
    env = np.minimum(1, t / att) * np.minimum(1, (d - t) / rel)
    return s * env
def sparkle(d=0.8, n=24):
    t = tt(d); out = np.zeros(len(t))
    for _ in range(n):
        i = int(rng.uniform(0, d * 0.6) * SR); f = rng.uniform(2500, 6500); tk = t[: len(t) - i]
        out[i:] += np.sin(2 * np.pi * f * tk) * np.exp(-tk * rng.uniform(20, 40)) * rng.uniform(.2, 1)
    return out * 0.2

m2f = lambda m: 440 * 2 ** ((m - 69) / 12)
# chords: Fmaj7, Am7, Dm7, Cmaj7 (2s each)
CHORDS = [[53, 57, 60, 64], [57, 60, 64, 67], [50, 53, 57, 60], [48, 52, 55, 59]]
ROOTS = [41, 45, 38, 36]

# ---------- intro ----------
add(pad([m2f(n) for n in CHORDS[0]], 6.2, att=2.0, rel=0.6, fc=900), 0.0, 0.5)
for i in range(26): add(key_tap(), 0.45 + i * 0.05, 0.35 + 0.1 * (i % 3 == 0), pan=(i - 13) / 30)
add(whoosh(0.55), 2.45, 0.35)
add(soft_boom(), 3.0, 0.6)
for j, n in enumerate([65, 69, 72, 76]): add(bell(m2f(n)), 3.0 + j * 0.03, 0.12, pan=(j - 1.5) / 3)
add(sparkle(1.2, 30), 3.0, 0.8)
for j, n in enumerate([77, 81, 84, 88, 89]): add(pluck(m2f(n), 0.8, 6000), 4.15 + j * 0.1, 0.12, pan=(j - 2) / 4)
add(whoosh(0.5), 5.5, 0.5)

# ---------- groove (6 -> 46), with a breakdown for the AI switch ----------
def groove_active(b): return not (28.0 <= b < 29.95)
b = 6.0
while b < 46.0 - 1e-6:
    bar = int((b - 6.0) // 2) % 4
    if groove_active(b):
        add(kick(), b, 0.7)
        for e in range(2):
            add(shaker(), b + e * 0.25, 0.12 if e == 0 else 0.2, pan=0.25)
        # bass on beat and off-beat
        add(pluck(m2f(ROOTS[bar]), 0.45, 600), b, 0.55)
        add(pluck(m2f(ROOTS[bar] + 12), 0.3, 800), b + 0.25, 0.25)
        # arpeggio 8ths
        for e in range(2):
            idx = int(((b - 6.0) / 0.25) + e) % 4
            n = CHORDS[bar][idx] + 12
            add(pluck(m2f(n), 0.5, 3500), b + e * 0.25, 0.07, pan=0.4 * (-1) ** (idx))
    b += 0.5
# pads per chord change
for k in range(20):
    t0 = 6.0 + k * 2
    if t0 >= 46: break
    add(pad([m2f(n) for n in CHORDS[k % 4]], 2.3, att=0.3, rel=0.5, fc=1200), t0, 0.22)

# transitions
for c in [10.0, 16.0, 22.0, 28.0, 35.0, 41.0, 46.0]:
    add(whoosh(0.4), c - 0.4, 0.4); add(soft_boom(0.8), c, 0.25)
for c in [7.33, 8.66]: add(whoosh(0.25), c - 0.25, 0.25)
for s in [6.12, 7.45, 8.78, 33.25, 47.8, 48.0]:
    add(pluck(m2f(84), 0.3, 7000), s + 0.05, 0.15); add(pluck(m2f(91), 0.3, 7000), s + 0.12, 0.1)
# search focus steps, map pins, carousel
for k in range(4): add(click(2600), 17.8 + k * 0.4, 0.18)
for k in range(4): add(pluck(m2f([72, 76, 79, 84][k]), 0.6, 5000), 24.8 + k * 0.3, 0.14, pan=(k - 1.5) / 3)
for s in [42.4, 43.6]: add(whoosh(0.5), s, 0.3)
add(sparkle(0.8, 16), 44.7, 0.6)

# AI switch breakdown
add(pad([m2f(n) for n in [53, 57, 60, 64, 67]], 2.2, att=0.4, rel=0.4, fc=800), 28.0, 0.25)
add(click(1800, 0.04), 29.15, 0.7); add(click(1200, 0.05), 29.2, 0.4)
for j, n in enumerate([72, 76, 79, 84]): add(bell(m2f(n), 1.5), 29.2 + j * 0.06, 0.1)
add(whoosh(0.35), 29.6, 0.4)

# ---------- outro ----------
add(soft_boom(1.6), 46.0, 0.6)
add(pad([m2f(n) for n in [41, 53, 57, 60, 64, 67]], 6.0, att=0.2, rel=2.5, fc=1600), 46.0, 0.4)
for j, n in enumerate([65, 72, 76, 79, 84]): add(bell(m2f(n), 3.5), 46.05 + j * 0.05, 0.1, pan=(j - 2) / 4)
for i in range(11): add(key_tap(), 48.2 + i / 30, 0.3)

mix = np.stack([L, R], 1)
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
mix /= np.max(np.abs(mix)) / 0.89
fl = int(0.8 * SR); fade = np.ones(N); fade[-fl:] = np.linspace(1, 0, fl)
mix *= fade[:, None]
with wave.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'soundtrack.wav'), 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('ok', mix.shape)
