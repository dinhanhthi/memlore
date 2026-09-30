// Contact-sheet stills of the film, to eyeball every scene without rendering video.
//
//   node docs/showcase/free-style-vi/stills.mjs                     # all scenes -> stills-out/
//   node docs/showcase/free-style-vi/stills.mjs --scene map,sync    # only these scenes
//   node docs/showcase/free-style-vi/stills.mjs --out some-dir      # other output folder
//
// Per scene (960x540 PNG): start + 0.5 s, each voice cue (c.vo[k].at, mapped to film time),
// the middle, end - 0.2 s. Writes <out>/<scene>-<t>.png and <out>/index.html (one row per scene).
// Prints page/console errors and T.missing / cue.missing when those globals exist.
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
const out = path.resolve(dir, opt('--out') || 'stills-out');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(showcase, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(showcase + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
let errors = 0;
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors++; console.log('[console]', m.text()); } });
await page.goto(`http://127.0.0.1:${server.address().port}/free-style-vi/film.html`);
await page.evaluate(() => window.ready);

// scene list with film-time stills: cue times go through the scene's source -> output map
const scenes = await page.evaluate(async () => {
  const tl = await (await fetch('timeline.json')).json();
  const lay = Timing.layout(tl, {});
  return SCENES.map((s, i) => {
    const m = lay.scenes[i];
    return { id: s.id, start: s.start, dur: s.dur, cues: s.ctx.vo.map(v => s.start + m.toOutput(v.at)) };
  });
});
const r2 = x => Math.round(x * 100) / 100;
fs.mkdirSync(out, { recursive: true });
const rows = [];
for (const sc of scenes) {
  if (only && !only.includes(sc.id)) continue;
  const end = sc.start + sc.dur;
  const times = [sc.start + 0.5, ...sc.cues, sc.start + sc.dur / 2, end - 0.2]
    .map(t => r2(Math.min(Math.max(t, sc.start), end - 0.2)))
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((a, b) => a - b);
  const shots = [];
  for (const t of times) {
    await page.evaluate(t => window.render(t), t);
    const name = `${sc.id}-${t}.png`;
    await page.screenshot({ path: path.join(out, name) });
    shots.push({ name, t });
  }
  rows.push({ id: sc.id, shots });
  console.log(`${sc.id.padEnd(11)} ${shots.length} stills`);
}
const missing = await page.evaluate(() => ({
  T: typeof T !== 'undefined' && T.missing ? [...T.missing] : [],
  cue: typeof cue !== 'undefined' && cue.missing ? [...cue.missing] : [],
}));
if (missing.T.length) console.log('T.missing:', missing.T);
if (missing.cue.length) console.log('cue.missing:', missing.cue);
await browser.close();
server.close();

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>Film stills</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #111; --mut: #666; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #eee; --mut: #999; } }
body { background: var(--bg); color: var(--fg); font: 13px system-ui, sans-serif; margin: 16px; }
h2 { font-size: 15px; margin: 20px 0 6px; }
.row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
figure { margin: 0; flex: none; }
img { width: 320px; height: 180px; display: block; border: 1px solid var(--mut); }
figcaption { color: var(--mut); font-size: 12px; margin-top: 2px; }
</style>
${rows.map(r => `<h2>${esc(r.id)}</h2>\n<div class="row">${r.shots.map(s => `<figure><a href="${esc(s.name)}"><img src="${esc(s.name)}" loading="lazy"></a><figcaption>${esc(r.id)} @ ${s.t}s</figcaption></figure>`).join('')}</div>`).join('\n')}
`);
console.log(`${rows.length} scenes, ${rows.reduce((n, r) => n + r.shots.length, 0)} stills, ${errors} page errors -> ${path.relative(process.cwd(), out)}/index.html`);
if (errors) process.exitCode = 1;
