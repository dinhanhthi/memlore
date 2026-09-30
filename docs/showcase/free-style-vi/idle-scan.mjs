// Idle scan: finds stretches of the film where (almost) nothing on screen moves.
//
//   node docs/showcase/free-style-vi/idle-scan.mjs [--scene a,b] [--thr 0.15] [--px 8] [--min 1.5] [--step 0.25] [--all]
//
// Samples the film every --step s (0.25), downscales each frame to 320x180 grayscale and compares it with the
// previous sample two ways: the mean absolute difference (0-255 scale) and the number of pixels that changed by
// more than 12 levels (the mean alone misses typing, where a few glyph pixels change). A step is idle when
// the mean stays below --thr (default 0.15, i.e. ~0.06 % of full scale) AND fewer than --px pixels (8) changed,
// which still lets a blinking caret count as idle. A run of idle steps longer than --min s (1.5) is reported
// per scene, in scene-relative seconds. Ambient background motion is taken out before measuring: the drifting
// colour blobs (blobs() in lib.js) and the per-frame film grain are hidden in the scan, so the drift baseline is
// just JPEG noise (~0.02) and a frame where only the background moves reads as idle, while any real element
// moving (a word rising, a card popping, a bob) does not; 0.15 is well above the noise and below a slow bob.
// --all also prints each scene's median / min step difference (its drift baseline). Exit 1 when stretches exist.
import { chromium } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const showcase = path.dirname(dir);
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const only = opt('--scene')?.split(',');
const THR = parseFloat(opt('--thr', '0.15')), PX = parseInt(opt('--px', '8')), MIN = parseFloat(opt('--min', '1.5')), STEP = parseFloat(opt('--step', '0.25'));
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
const dec = await browser.newPage(); // blank page used only to decode + downscale screenshots
let errors = 0;
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
await page.goto(`http://127.0.0.1:${server.address().port}/free-style-vi/film.html`);
await page.evaluate(() => window.ready);
const scenes = await page.evaluate(() => SCENES.map(s => ({ id: s.id, start: s.start, dur: s.dur })));

const gray = async buf => dec.evaluate(async b64 => {
  const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
  const cv = new OffscreenCanvas(320, 180), cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0, 320, 180);
  const d = cx.getImageData(0, 0, 320, 180).data, g = new Float32Array(320 * 180);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return Array.from(g);
}, buf.toString('base64'));

const r2 = x => Math.round(x * 100) / 100;
let total = 0;
for (const sc of scenes) {
  if (only && !only.includes(sc.id)) continue;
  const diffs = [], counts = []; // diffs[i] = change between sample i and i+1, samples at sc.start + i*STEP
  let prev = null;
  for (let t = 0; t < sc.dur - 0.05; t += STEP) {
    await page.evaluate(t => {
      window.render(t);
      document.getElementById('grain').style.display = 'none';
      for (const e of document.querySelectorAll('#stage div')) if (e.style.background.includes('transparent 65%')) e.style.visibility = 'hidden';
    }, sc.start + t);
    const g = await gray(await page.screenshot({ type: 'jpeg', quality: 92 }));
    if (prev) { let s = 0, n = 0; for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - prev[i]); s += d; if (d > 12) n++; } diffs.push(s / g.length); counts.push(n); }
    prev = g;
  }
  const stretches = [];
  for (let i = 0; i < diffs.length;) {
    const idle = k => diffs[k] < THR && counts[k] < PX;
    if (!idle(i)) { i++; continue; }
    let j = i; while (j < diffs.length && idle(j)) j++;
    if ((j - i) * STEP > MIN) stretches.push([i * STEP, j * STEP]);
    i = j;
  }
  total += stretches.length;
  const sorted = [...diffs].sort((a, b) => a - b);
  console.log(`${sc.id.padEnd(11)} ${String(r2(sc.dur)).padStart(5)} s  ${stretches.length} idle stretches` + (showAll ? `  (median ${r2(sorted[sorted.length >> 1])}, min ${r2(sorted[0])})` : ''));
  for (const [a, b] of stretches) console.log(`   idle ${r2(a)}-${r2(b)} s (${r2(b - a)} s) of the scene, film ${r2(sc.start + a)}-${r2(sc.start + b)}`);
}
await browser.close();
server.close();
console.log(`${total} idle stretches > ${MIN} s (thr ${THR}), ${errors} page errors`);
if (total || errors) process.exitCode = 1;
