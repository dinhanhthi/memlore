// Overflow scan: for every scene, at the same sample times as stills.mjs (start + 0.5 s, each voice cue,
// middle, end - 0.2 s), flag visible text that
//   (a) sits in an element whose scrollWidth > clientWidth (single-line clip / hidden overflow),
//   (b) has a text box outside its nearest card / overflow:hidden|clip ancestor,
//   (c) has a text box outside the 1920x1080 frame.
// Decorative layers (background blobs, stickers, confetti, images) and invisible text (opacity ~0) are ignored.
//
//   node docs/showcase/free-style-vi/overflow-scan.mjs [--scene a,b] [--all]   (--all prints every finding)
// Exit 1 on findings.
import { chromium } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const showcase = path.dirname(dir);
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('--scene')?.split(',');
const showAll = args.includes('--all');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(showcase, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(showcase + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let errors = 0;
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors++; console.log('[console]', m.text()); } });
await page.goto(`http://127.0.0.1:${server.address().port}/free-style-vi/film.html`);
await page.evaluate(() => window.ready);

const scenes = await page.evaluate(async () => {
  const tl = await (await fetch('timeline.json')).json();
  const lay = Timing.layout(tl, {});
  return SCENES.map((s, i) => ({ id: s.id, start: s.start, dur: s.dur, cues: s.ctx.vo.map(v => s.start + lay.scenes[i].toOutput(v.at)) }));
});
const r2 = x => Math.round(x * 100) / 100;

// runs in the page: returns findings for the currently rendered frame
const scan = () => {
  const out = [];
  const TOL = 2;
  const cardSel = '.panel, .panel-2, .window, .chip, .pill, .btn, .toggle';
  const effOpacity = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; o *= parseFloat(cs.opacity); } return o; };
  const decorative = el => !!el.closest('img, svg, canvas, [data-decor]') || (() => {
    // background blob wrappers and sticker/confetti layers carry no text; also skip anything inside #grain/#vignette
    return !!el.closest('#grain, #vignette');
  })();
  const clipper = el => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (e.id === 'stage' || e.classList.contains('scene') || e.classList.contains('inner') || e === document.body) return null;
      const cs = getComputedStyle(e);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY) || e.matches(cardSel)) return e;
    }
    return null;
  };
  const walker = document.createTreeWalker(document.getElementById('stage'), NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('.katex-mathml') || decorative(el) || effOpacity(el) < 0.08) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const box = rects.reduce((b, r) => ({ l: Math.min(b.l, r.left), t: Math.min(b.t, r.top), r: Math.max(b.r, r.right), b: Math.max(b.b, r.bottom) }), { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
    // entirely hidden by an overflow:hidden ancestor -> not visible
    let hiddenAway = false;
    for (let e = el.parentElement; e && !hiddenAway; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) { const r = e.getBoundingClientRect(); if (box.r <= r.left || box.l >= r.right || box.b <= r.top || box.t >= r.bottom) hiddenAway = true; }
    }
    if (hiddenAway) continue;
    const push = (kind, detail) => { const k = kind + text; if (seen.has(k)) return; seen.add(k); out.push({ kind, text: text.slice(0, 80), detail }); };
    // (c) frame
    if (box.l < -TOL || box.t < -TOL || box.r > 1920 + TOL || box.b > 1080 + TOL) push('frame', `box ${[box.l, box.t, box.r, box.b].map(Math.round)}`);
    // (a) scrollWidth on the text's element and its block parents up to the clipper
    for (let e = el; e && e.id !== 'stage'; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display.startsWith('inline') && e !== el) continue;
      if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 4 && !e.classList.contains('scene') && !e.classList.contains('inner')) {
        push('scrollWidth', `${e.tagName.toLowerCase()}.${e.className} scrollW ${e.scrollWidth} > clientW ${e.clientWidth}`); break;
      }
      if (e.matches(cardSel) || /(hidden|clip)/.test(cs.overflowX)) break;
    }
    // (b) card / overflow ancestor
    const c = clipper(el);
    if (c) {
      const cr = c.getBoundingClientRect();
      // the text range box is the font's ascent+descent, taller than a tight line box: allow 6 px vertically
      if (cr.width > 0 && (box.l < cr.left - TOL || box.r > cr.right + TOL || box.t < cr.top - 6 || box.b > cr.bottom + 6))
        push('card', `${c.tagName.toLowerCase()}.${c.className} [${[cr.left, cr.top, cr.right, cr.bottom].map(Math.round)}] vs text [${[box.l, box.t, box.r, box.b].map(Math.round)}]`);
    }
  }
  return out;
};

let total = 0;
for (const sc of scenes) {
  if (only && !only.includes(sc.id)) continue;
  const end = sc.start + sc.dur;
  // the stills.mjs sample times, plus a 0.25 s grid so a finding can be told from a transient entrance/exit:
  // a finding counts only when its geometry is identical in two consecutive samples (settled, not moving).
  const grid = [];
  for (let t = sc.start; t < end - 0.2; t += 0.25) grid.push(t);
  grid.push(end - 0.2);
  const times = [sc.start + 0.5, ...sc.cues, sc.start + sc.dur / 2, end - 0.2, ...grid]
    .map(t => r2(Math.min(Math.max(t, sc.start), end - 0.2)))
    .filter((t, i, a) => a.indexOf(t) === i).sort((a, b) => a - b);
  const found = new Map();
  let prev = new Map();
  for (const t of times) {
    await page.evaluate(t => window.render(t), t);
    const cur = new Map();
    for (const f of await page.evaluate(scan)) {
      const k = f.kind + f.text + f.detail;
      cur.set(k, f);
      if (prev.has(k) && !found.has(f.kind + f.text)) found.set(f.kind + f.text, { ...f, t });
    }
    prev = cur;
  }
  const list = [...found.values()];
  total += list.length;
  console.log(`${sc.id.padEnd(11)} ${list.length} findings`);
  for (const f of showAll ? list : list.slice(0, 1)) console.log(`   [${f.kind}] @${f.t}s "${f.text}" ${f.detail}`);
}
await browser.close();
server.close();
console.log(`${total} findings, ${errors} page errors`);
if (total || errors) process.exitCode = 1;
