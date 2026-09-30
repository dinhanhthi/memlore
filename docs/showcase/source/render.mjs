// Render the Memlore showcase film to MP4.
//
//   node docs/showcase/source/render.mjs            -> docs/showcase/memlore-intro.mp4     (English)
//   node docs/showcase/source/render.mjs vi         -> docs/showcase/memlore-intro-vi.mp4  (Vietnamese)
//   node docs/showcase/source/render.mjs vi 12.5,30 -> stills/still-vi-12.5.png ...        (inspect frames)
//
// memlore.html draws every frame on a canvas from a pure render(t); this script
// serves docs/showcase/ (the film plus the shared ../assets) on localhost, steps t frame by frame in headless Chromium,
// and pipes PNG frames plus soundtrack.wav into ffmpeg.
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const showcase = path.dirname(dir);
const [lang = 'en', stills] = process.argv.slice(2);
if (!['en', 'vi'].includes(lang)) throw new Error(`unknown language "${lang}" (en | vi)`);
const FPS = 60, DUR = 52;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(showcase, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(showcase + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(() => { window.__capture = true; });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/source/memlore.html?lang=${lang}`);
await page.evaluate(() => window.ready);
const grab = t => page.evaluate(t => { render(t); return document.getElementById('out').toDataURL('image/png'); }, t);

if (stills) {
  fs.mkdirSync(path.join(dir, 'stills'), { recursive: true });
  for (const t of stills.split(',').map(Number)) {
    const d = await grab(t);
    fs.writeFileSync(path.join(dir, 'stills', `still-${lang}-${t}.png`), Buffer.from(d.split(',')[1], 'base64'));
  }
} else {
  const wav = path.join(dir, 'soundtrack.wav');
  if (!fs.existsSync(wav)) throw new Error('soundtrack.wav missing — run: python3 docs/showcase/source/soundtrack.py');
  const out = path.join(dir, '..', lang === 'en' ? 'memlore-intro.mp4' : `memlore-intro-${lang}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-i', wav,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now(), NF = DUR * FPS;
  for (let i = 0; i < NF; i++) {
    const buf = Buffer.from((await grab(i / FPS)).split(',')[1], 'base64');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${NF}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
