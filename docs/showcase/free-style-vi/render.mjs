// Render the free-style Memlore film.
//
//   node docs/showcase/free-style-vi/render.mjs                 -> docs/showcase/free-style-showcase.vi.mp4 (1080p60)
//   node docs/showcase/free-style-vi/render.mjs --preview       -> stills/preview.mp4 (30 fps, fast)
//   node docs/showcase/free-style-vi/render.mjs --preview 40 60 -> preview of 40 s .. 60 s only
//   node docs/showcase/free-style-vi/render.mjs --stills 3,12.5 -> stills/still-3.png, stills/still-12.5.png
//
// film.html draws every frame from a pure render(t). This script serves docs/showcase/ (the
// film plus the shared ../assets) on localhost, steps t in headless Chromium, and pipes JPEG
// frames + the soundtrack into ffmpeg.
// Every preview/final run first re-runs mix.mjs (free, ~10 s), so audio.wav always matches the
// current timeline, narration and music; mix.mjs stops the render when music.mp3 is stale.
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import config from './config.mjs';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const showcase = path.dirname(dir);
const args = process.argv.slice(2);
const mode = args[0] === '--preview' ? 'preview' : args[0] === '--stills' ? 'stills' : 'final';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(showcase, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(showcase + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const scale = mode === 'preview' ? 0.5 : 1;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/free-style-vi/film.html`);
await page.evaluate(() => window.ready);
const DUR = await page.evaluate(() => window.DUR);
const cdp = await page.context().newCDPSession(page);
const shot = async (t, format = 'jpeg') => {
  await page.evaluate(t => window.render(t), t);
  const { data } = await cdp.send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 94 : undefined, optimizeForSpeed: true });
  return Buffer.from(data, 'base64');
};

// Warm-up: paint every scene once so text and images are rasterized before the first real frame.
for (let t = 0; t < DUR; t += 1) await shot(t);

if (mode === 'stills') {
  fs.mkdirSync(path.join(dir, 'stills'), { recursive: true });
  for (const t of args[1].split(',').map(Number)) fs.writeFileSync(path.join(dir, 'stills', `still-${t}.png`), await shot(t, 'png'));
  console.log('stills written');
} else {
  const FPS = mode === 'preview' ? 30 : 60;
  const from = mode === 'preview' && args[1] ? Number(args[1]) : 0;
  const to = mode === 'preview' && args[2] ? Number(args[2]) : DUR;
  execFileSync(process.execPath, [path.join(dir, 'mix.mjs')], { stdio: 'inherit' });
  const wav = path.join(dir, config.audio);
  const hasWav = fs.existsSync(wav);
  if (mode === 'final' && !hasWav) throw new Error('mix.mjs did not write audio.wav');
  if (mode === 'final') {
    const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString());
    if (Math.abs(len - DUR) > 0.05) throw new Error(`${path.basename(wav)} is ${len} s but the film is ${DUR} s — re-run fit.mjs / soundtrack.py / mix.mjs`);
  }
  console.log('audio:', path.basename(wav));
  const out = mode === 'final' ? path.resolve(dir, config.film) : path.join(dir, 'stills', 'preview.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const audio = hasWav ? ['-ss', String(from), '-t', String(to - from), '-i', wav] : [];
  const enc = mode === 'final'
    ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'];
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', ...audio,
    ...enc, ...(hasWav ? ['-c:a', 'aac', '-b:a', '256k'] : []), '-t', String(to - from), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now(), NF = Math.round((to - from) * FPS);
  for (let i = 0; i < NF; i++) {
    const buf = await shot(from + i / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % (FPS * 10) === 0) console.log(`frame ${i}/${NF}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
