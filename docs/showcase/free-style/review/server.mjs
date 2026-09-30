// Local review server for the free-style film.
//
//   node docs/showcase/free-style/review/server.mjs [--port N]   -> http://127.0.0.1:5190/review/
//
// Serves the free-style/ folder (plus the shared docs/showcase/assets/ at /assets/), persists review/review.json (rev-checked, atomic writes)
// and regenerates review/preview.wav from draft timing via soundtrack.py.
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';
import crypto from 'crypto';
import { spawn } from 'child_process';

const REVIEW = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.dirname(REVIEW);
const ASSETS = path.join(path.dirname(ROOT), 'assets');
const REVIEW_FILE = path.join(REVIEW, 'review.json');
const DRAFT_FILE = path.join(REVIEW, '.draft-timeline.json');
const PREVIEW_FILE = path.join(REVIEW, 'preview.wav');
const MAX_BODY = 1024 * 1024;
const pi = process.argv.indexOf('--port');
const PORT = pi > 0 ? Number(process.argv[pi + 1]) : 5190;

// shared timing maths (classic script -> globalThis.Timing)
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'timing.js'), 'utf8'), sandbox);
const { Timing } = sandbox;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webp': 'image/webp', '.md': 'text/plain',
};

const readTimeline = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));

function send(res, code, obj, headers = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // past the limit: drain, then answer 413
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('body too large'), { code: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = v => typeof v === 'number' && Number.isFinite(v);

// errors for a timing map { sceneId: { speed?, beats?, warp?, snap? } }
function validateTiming(timing, tl) {
  if (!isObj(timing)) return ['timing must be an object'];
  const errs = [], byId = new Map(tl.scenes.map(s => [s.id, s]));
  for (const [id, ov] of Object.entries(timing)) {
    if (!byId.has(id)) { errs.push(`timing: unknown scene "${id}"`); continue; }
    if (!isObj(ov)) { errs.push(`timing.${id} must be an object`); continue; }
    const bad = Object.keys(ov).filter(k => !['speed', 'beats', 'warp', 'snap'].includes(k));
    if (bad.length) { errs.push(`timing.${id}: unknown keys ${bad.join(', ')}`); continue; }
    if (Array.isArray(ov.warp) && !ov.warp.every(isObj)) { errs.push(`timing.${id}.warp entries must be objects`); continue; }
    const merged = { ...byId.get(id) };
    for (const [k, v] of Object.entries(ov)) { if (v === null) delete merged[k]; else merged[k] = v; }
    for (const e of Timing.validate(merged, tl.bpm || 120)) errs.push(`timing.${id}: ${e}`);
  }
  return errs;
}

function validateReview(doc, tl) {
  if (!isObj(doc)) return ['body must be an object'];
  const errs = [];
  if (doc.schemaVersion !== 1) errs.push('schemaVersion must be 1');
  if (doc.film !== 'free-style') errs.push('film must be "free-style"');
  if (!Number.isInteger(doc.rev)) errs.push('rev must be an integer');
  errs.push(...validateTiming(doc.timing, tl));
  if (!Array.isArray(doc.comments)) return [...errs, 'comments must be an array'];
  const ids = new Set(tl.scenes.map(s => s.id));
  doc.comments.forEach((c, i) => {
    const at = `comments[${i}]`;
    if (!isObj(c)) return errs.push(`${at} must be an object`);
    if (typeof c.id !== 'string') errs.push(`${at}.id must be a string`);
    if (!ids.has(c.sceneId)) errs.push(`${at}.sceneId is not a scene`);
    if (!fin(c.sourceT)) errs.push(`${at}.sourceT must be a finite number`);
    if (!(fin(c.x) && c.x >= 0 && c.x <= 1920)) errs.push(`${at}.x outside [0, 1920]`);
    if (!(fin(c.y) && c.y >= 0 && c.y <= 1080)) errs.push(`${at}.y outside [0, 1080]`);
    if (!(typeof c.text === 'string' && c.text.length <= 5000)) errs.push(`${at}.text must be a string of <= 5000 chars`);
    if (!['open', 'resolved', 'wontfix'].includes(c.status)) errs.push(`${at}.status must be open|resolved|wontfix`);
    if (!(c.reply === null || typeof c.reply === 'string')) errs.push(`${at}.reply must be a string or null`);
    if (typeof c.createdAt !== 'string') errs.push(`${at}.createdAt must be a string`);
    if (!(c.resolvedAt === null || typeof c.resolvedAt === 'string')) errs.push(`${at}.resolvedAt must be a string or null`);
  });
  return errs;
}

function writeAtomic(file, data) {
  const tmp = path.join(REVIEW, `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadReview() {
  if (!fs.existsSync(REVIEW_FILE)) {
    const doc = { schemaVersion: 1, film: 'free-style', rev: 0, updatedAt: new Date().toISOString(), timing: {}, comments: [] };
    writeAtomic(REVIEW_FILE, JSON.stringify(doc, null, 2) + '\n');
  }
  return JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
}

// serialize review reads-then-writes so concurrent PUTs cannot interleave
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

async function putReview(req, res) {
  const doc = await readBody(req);
  const errs = validateReview(doc, readTimeline());
  if (errs.length) return send(res, 422, { errors: errs });
  await serial(() => {
    const cur = loadReview();
    if (doc.rev !== cur.rev) return send(res, 409, { rev: cur.rev });
    const next = { ...doc, rev: cur.rev + 1, updatedAt: new Date().toISOString() };
    writeAtomic(REVIEW_FILE, JSON.stringify(next, null, 2) + '\n');
    send(res, 200, { rev: next.rev, updatedAt: next.updatedAt });
  });
}

// one soundtrack.py at a time; a newer request kills and supersedes the running one
let running = null;

async function postSoundtrack(req, res) {
  const body = await readBody(req);
  const tl = readTimeline();
  const timing = isObj(body) ? body.timing : undefined;
  const errs = validateTiming(timing, tl);
  if (errs.length) return send(res, 422, { errors: errs });
  if (running) { running.superseded = true; running.proc.kill('SIGTERM'); }
  fs.writeFileSync(DRAFT_FILE, JSON.stringify(Timing.mergeTiming(tl, timing), null, 2) + '\n');
  const tmpOut = path.join(REVIEW, `.preview-${crypto.randomBytes(4).toString('hex')}.wav`);
  const t0 = Date.now();
  const proc = spawn('python3', [path.join(ROOT, 'soundtrack.py'), '--timeline', DRAFT_FILE, '--out', tmpOut], { stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { proc, superseded: false };
  running = job;
  let out = '', err = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });
  let done = false; // 'error' and 'close' can both fire
  const finish = code => {
    if (done) return;
    done = true;
    if (running === job) running = null;
    if (job.superseded) { fs.rmSync(tmpOut, { force: true }); return send(res, 409, { superseded: true }); }
    if (code !== 0) { fs.rmSync(tmpOut, { force: true }); return send(res, 500, { error: 'soundtrack.py failed', stderr: err.slice(-2000) }); }
    try { fs.renameSync(tmpOut, PREVIEW_FILE); }
    catch (e) { fs.rmSync(tmpOut, { force: true }); return send(res, 500, { error: e.message }); }
    const m = out.match(/:\s*([\d.]+) s,/);
    send(res, 200, { dur: m ? Number(m[1]) : null, ms: Date.now() - t0 });
  };
  proc.on('error', e => { err += e.message; finish(-1); });
  proc.on('close', finish);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400, { 'Cache-Control': 'no-store' }); return res.end(); }
  // film.html sits at /film.html here, so its ../assets/ URLs arrive as /assets/
  const [base, sub] = rel.startsWith('/assets/') ? [ASSETS, rel.slice('/assets'.length)] : [ROOT, rel];
  let file = path.resolve(path.join(base, sub));
  if (!(file === base || file.startsWith(base + path.sep))) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// API calls only from this server's own pages: blocks cross-site "simple" requests and
// DNS-rebinding pages (Host/Origin not ours), and non-JSON bodies on writes
const OWN_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
function apiGuard(req, res) {
  const origin = req.headers.origin;
  if (!OWN_HOSTS.includes(req.headers.host) || (origin !== undefined && !OWN_HOSTS.some(h => origin === `http://${h}`))) {
    send(res, 403, { error: 'forbidden' });
    return false;
  }
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if ((req.method === 'PUT' || req.method === 'POST') && type !== 'application/json') {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  // DNS-rebinding guard for every request (static files include review.json)
  if (!OWN_HOSTS.includes(req.headers.host)) return send(res, 403, { error: 'forbidden' });
  if ((pathname === '/api' || pathname.startsWith('/api/')) && !apiGuard(req, res)) return;
  if (pathname === '/api/review' && req.method === 'GET') return send(res, 200, loadReview());
  if (pathname === '/api/review' && req.method === 'PUT') return putReview(req, res);
  if (pathname === '/api/soundtrack' && req.method === 'POST') return postSoundtrack(req, res);
  if (pathname === '/api' || pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
  if (pathname === '/') { res.writeHead(302, { Location: '/review/', 'Cache-Control': 'no-store' }); return res.end(); }
  if (pathname === '/review') { res.writeHead(301, { Location: '/review/', 'Cache-Control': 'no-store' }); return res.end(); }
  serveStatic(req, res, pathname);
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`review server: http://127.0.0.1:${PORT}/review/`));
