// Shared helpers for the free-style film. Everything is a pure function of time:
// scenes build their DOM once, then update(lt) sets styles from the local time.
/* eslint-disable no-unused-vars */
const W = 1920, H = 1080, BEAT = 0.5, BAR = 2;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, p) => a + (b - a) * p;
// progress of t through [a, b], clamped 0..1
const prog = (t, a, b) => clamp((t - a) / (b - a));
const Ease = {
  linear: p => p,
  inCubic: p => p * p * p,
  outCubic: p => 1 - Math.pow(1 - p, 3),
  inOutCubic: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  outQuint: p => 1 - Math.pow(1 - p, 5),
  outExpo: p => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inOutExpo: p => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
  outBack: p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  outBackSoft: p => { const c1 = 1.1, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  outElastic: p => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
};
// eased progress helper: ep(t, a, b, 'outCubic')
const ep = (t, a, b, e = 'outCubic') => Ease[e](prog(t, a, b));
// a 0→1→0 window: rises over [a, a+r], holds, falls over [b-f, b]
const win = (t, a, b, r = 0.3, f = 0.3) => Math.min(ep(t, a, a + r), 1 - ep(t, b - f, b, 'inCubic'));

// deterministic pseudo-random
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
function css(e, styles) { Object.assign(e.style, styles); return e; }
function place(e, x, y, w, h) { css(e, { left: x + 'px', top: y + 'px' }); if (w != null) e.style.width = w + 'px'; if (h != null) e.style.height = h + 'px'; return e; }

function svgIcon(name, stroke = 'currentColor', sw = 2) {
  const node = (window.ICONS || {})[name];
  if (!node) return '';
  const inner = node.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function icon(name, size, parent, color, sw) {
  const e = el('span', 'ico', parent, svgIcon(name, color || 'currentColor', sw || 2));
  css(e, { width: size + 'px', height: size + 'px' });
  return e;
}

// transform helper: tf(e, {x, y, s, r, o, blur})
function tf(e, { x = 0, y = 0, s = 1, sx, sy, r = 0, o, blur, z } = {}) {
  const scale = sx != null || sy != null ? `scale(${sx ?? s}, ${sy ?? s})` : `scale(${s})`;
  e.style.transform = `translate(${x}px, ${y}px) ${scale} rotate(${r}deg)`;
  if (o != null) e.style.opacity = o;
  if (blur != null) e.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
  if (z != null) e.style.zIndex = z;
  return e;
}
// pop-in: scale from 0.6 with overshoot + fade, starting at a
function popIn(e, t, a, d = 0.45, extra = {}) {
  const p = prog(t, a, a + d);
  tf(e, { s: lerp(0.5, 1, Ease.outBack(p)), o: Ease.outCubic(p), ...extra });
  return p;
}
// rise-in: slide up + fade
function riseIn(e, t, a, d = 0.6, dist = 40, extra = {}) {
  const p = ep(t, a, a + d, 'outCubic');
  tf(e, { y: (1 - p) * dist, o: p, ...extra });
  return p;
}

// toggle switch element; setToggle(el, p) with p 0 (off) → 1 (on)
function toggle(parent, color = 'var(--gold)') {
  const t = el('div', 'toggle', parent);
  t._knob = el('div', 'knob', t);
  t._color = color;
  return t;
}
function setToggle(t, p) {
  t._knob.style.transform = `translateX(${34 * Ease.outBack(clamp(p))}px)`;
  t.style.background = p > 0.5 ? t._color : 'var(--ink-4)';
}

// Background of drifting soft blobs; colors = array of CSS colors.
function blobs(parent, colors, seed = 1, base = 'var(--ink)') {
  const wrap = el('div', 'abs', parent);
  css(wrap, { inset: 0, background: base, overflow: 'hidden' });
  const r = rng(seed);
  const items = colors.map(c => {
    const b = el('div', 'abs', wrap);
    const size = 700 + r() * 600;
    css(b, { width: size + 'px', height: size + 'px', left: (r() * W - size / 2) + 'px', top: (r() * H - size / 2) + 'px',
      borderRadius: '50%', background: `radial-gradient(circle, ${c} 0%, transparent 65%)`, opacity: 0.55 });
    return { b, ph: r() * 6.28, sp: 0.15 + r() * 0.2, amp: 80 + r() * 120 };
  });
  wrap.update = t => items.forEach(({ b, ph, sp, amp }) =>
    tf(b, { x: Math.sin(t * sp + ph) * amp, y: Math.cos(t * sp * 0.8 + ph) * amp * 0.7, s: 1 + 0.08 * Math.sin(t * 0.3 + ph) }));
  return wrap;
}

// Type text progressively: returns substring for chars/sec from a
const typed = (text, t, a, cps = 28) => text.slice(0, Math.max(0, Math.floor((t - a) * cps)));
const typeEnd = (text, a, cps = 28) => a + text.length / cps;
const caretHtml = (t, on = true) => (on && Math.floor(t * 2.4) % 2 === 0 ? '<span class="caret"></span>' : on ? '<span class="caret" style="opacity:0"></span>' : '');

// count-up number
const countUp = (t, a, b, to, from = 0) => Math.round(lerp(from, to, ep(t, a, b, 'outCubic')));

// headline: split into word spans that rise in a stagger
function words(parent, text, cls = '') {
  const wrap = el('div', cls, parent);
  wrap._w = text.split(' ').map((w, i, arr) => {
    if (w === '/') { el('br', '', wrap); return el('span', '', wrap); }
    const s = el('span', '', wrap, w.replace(/\|/g, ' ') + (i < arr.length - 1 ? '&nbsp;' : ''));
    css(s, { display: 'inline-block', willChange: 'transform' });
    return s;
  });
  return wrap;
}
function wordsIn(wrap, t, a, stagger = 0.07, d = 0.55, dist = 50) {
  wrap._w.forEach((s, i) => { const p = ep(t, a + i * stagger, a + i * stagger + d, 'outBack'); tf(s, { y: (1 - p) * dist, o: clamp(p * 1.6), r: (1 - p) * 4 }); });
}
function wordsOut(wrap, t, a, stagger = 0.04, d = 0.35) {
  wrap._w.forEach((s, i) => {
    const p = ep(t, a + i * stagger, a + i * stagger + d, 'inCubic');
    if (p > 0) tf(s, { y: -p * 40, o: 1 - p });
  });
}

// Scene registry; film.js wires them to timeline.json.
const SCENE_DEFS = {};
function scene(id, def) { SCENE_DEFS[id] = def; }

// Mac-style window with a title bar; returns { win, body }
function macWindow(parent, x, y, w, h, title = '') {
  const win = el('div', 'window abs', parent);
  place(win, x, y, w, h);
  el('div', 'bar', win, `<i></i><i></i><i></i><span class="title">${title}</span>`);
  const body = el('div', 'abs', win);
  css(body, { left: 0, right: 0, top: '46px', bottom: 0 });
  return { win, body };
}

// The one on-screen line per scene: a display title that rises in word by word.
function title(parent, text, { x = 0, y = 90, w = W, size = 88, align = 'center' } = {}) {
  const box = el('div', 'abs', parent);
  place(box, x, y, w);
  css(box, { textAlign: align });
  box._t = words(box, text, 'display');
  css(box._t, { fontSize: size + 'px' });
  return box;
}
function titleIn(box, t, a = 0.15, outAt) {
  wordsIn(box._t, t, a);
  box.style.opacity = outAt != null ? 1 - ep(t, outAt, outAt + 0.4, 'inCubic') : 1;
}
// start (source s) of voice-over line k of a scene, with a fallback when the manifest is missing
const voAt = (c, k = 0, fallback = 0.7) => (c.vo[k] ? c.vo[k].at : fallback);
const voEnd = (c, k = 0, fallback = 3) => (c.vo[k] ? c.vo[k].at + c.vo[k].dur : fallback);
// source time (s) where `phrase` starts in the scene's voice-over (case and punctuation ignored);
// searches line k only when given, else every line. Falls back to line k's start (or `fallback`).
const norm = w => w.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff']/g, '');
function cue(c, phrase, k, fallback = 0.7) {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  const lines = k == null ? c.vo : [c.vo[k]].filter(Boolean);
  for (const ln of lines) {
    const ws = ln.words || [];
    for (let i = 0; i + want.length <= ws.length; i++) if (want.every((w, j) => norm(ws[i + j].w) === w)) return ws[i].s;
  }
  if (!cue.missing) cue.missing = new Set();
  cue.missing.add(`${c.id}: "${phrase}"`);
  return voAt(c, k ?? 0, fallback);
}

function sticker(parent, name, x, y, w) {
  const img = el('img', 'abs', parent);
  img.src = `../assets/stickers/sticker-${name}.png`;
  place(img, x, y, w);
  css(img, { filter: 'drop-shadow(0 20px 30px #0009)' });
  return img;
}
// idle bob for stickers / floating things
const bob = (t, ph = 0, amp = 10) => Math.sin(t * 2.2 + ph) * amp;
