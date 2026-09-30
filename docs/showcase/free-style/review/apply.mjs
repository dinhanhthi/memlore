// Bake review timing into timeline.json.
//
//   node docs/showcase/free-style/review/apply.mjs [--dry] [--keep-review] [--review <path>] [--timeline <path>]
//
// Validates review.timing against timeline.json (exit 1, nothing written, on error), writes
// Timing.mergeTiming(timeline, review.timing) to timeline.json, then resets review.timing to {}
// (rev bumped) so the review app's baseline is the new timeline and a second run is a no-op.
// --dry prints the tables without writing; --keep-review writes timeline.json only.
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';

const REVIEW = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.dirname(REVIEW);
const TIMING_KEYS = ['speed', 'beats', 'warp', 'snap'];

// shared timing maths (classic script -> globalThis.Timing)
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'timing.js'), 'utf8'), sandbox);
const { Timing } = sandbox;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const plain = v => JSON.parse(JSON.stringify(v));

// errors for a timing map { sceneId: { speed?, beats?, warp?, snap? } }
function validateTiming(timing, tl) {
  if (!isObj(timing)) return ['timing must be an object'];
  const errs = [], byId = new Map(tl.scenes.map(s => [s.id, s]));
  for (const [id, ov] of Object.entries(timing)) {
    if (!byId.has(id)) { errs.push(`timing: unknown scene "${id}"`); continue; }
    if (!isObj(ov)) { errs.push(`timing.${id} must be an object`); continue; }
    const bad = Object.keys(ov).filter(k => !TIMING_KEYS.includes(k));
    if (bad.length) { errs.push(`timing.${id}: unknown keys ${bad.join(', ')}`); continue; }
    if (Array.isArray(ov.warp) && !ov.warp.every(isObj)) { errs.push(`timing.${id}.warp entries must be objects`); continue; }
    const merged = { ...byId.get(id) };
    for (const [k, v] of Object.entries(ov)) { if (v === null) delete merged[k]; else merged[k] = v; }
    for (const e of Timing.validate(merged, tl.bpm || 120)) errs.push(`timing.${id}: ${e}`);
  }
  return errs;
}

function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const timingOf = s => JSON.stringify(TIMING_KEYS.map(k => s[k] ?? null));

// { next, changed, comments, oldDur, newDur }; throws Error with .errors on invalid input
export function mergeTimeline(reviewPath, timelinePath, { dry = false, keepReview = false } = {}) {
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const tl = JSON.parse(fs.readFileSync(timelinePath, 'utf8'));
  const timing = isObj(review) && review.timing !== undefined ? review.timing : {};
  const errs = validateTiming(timing, tl);
  if (errs.length) throw Object.assign(new Error(`invalid review timing:\n  ${errs.join('\n  ')}`), { errors: errs });

  // deep copy of tl: top-level key order (bpm, note, scenes) is kept, scene keys are next
  const next = plain(Timing.mergeTiming(tl, timing));

  const L0 = Timing.layout(tl), L1 = Timing.layout(next);
  const changed = [];
  next.scenes.forEach((s, i) => {
    const a = L0.scenes[i], b = L1.scenes[i];
    if (timingOf(tl.scenes[i]) === timingOf(s) && a.outDur === b.outDur) return;
    changed.push({
      id: s.id, oldBeats: a.outDur / Timing.BEAT, newBeats: b.outDur / Timing.BEAT,
      speed: s.speed ?? 1, warp: s.warp || [], delta: b.outDur - a.outDur,
    });
  });

  const byId = new Map(L1.scenes.map(s => [s.id, s]));
  const comments = (Array.isArray(review.comments) ? review.comments : [])
    .filter(c => isObj(c) && c.status === 'open' && byId.has(c.sceneId))
    .map(c => { const s = byId.get(c.sceneId); return { id: c.id, sceneId: c.sceneId, t: s.start + s.toOutput(c.sourceT), text: String(c.text ?? '') }; });

  if (!dry) {
    writeAtomic(timelinePath, JSON.stringify(next, null, 2) + '\n');
    if (!keepReview && Object.keys(timing).length) {
      const rv = { ...review, timing: {}, rev: (Number.isInteger(review.rev) ? review.rev : 0) + 1, updatedAt: new Date().toISOString() };
      writeAtomic(reviewPath, JSON.stringify(rv, null, 2) + '\n');
    }
  }
  return { next: next, changed, comments, oldDur: L0.dur, newDur: L1.dur };
}

function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((c, i) => c.padEnd(w[i])).join(' | ').trimEnd();
  return [line(head), w.map(n => '-'.repeat(n)).join('-|-'), ...rows.map(line)].join('\n');
}

const num = v => String(Math.round(v * 1000) / 1000);

export function report({ changed, comments, oldDur, newDur }) {
  const out = [];
  out.push(changed.length
    ? table(['id', 'beats', 'speed', 'ranges', 'Δs'], changed.map(c => [
      c.id, `${num(c.oldBeats)} → ${num(c.newBeats)}`, num(c.speed),
      c.warp.map(r => `${num(r.from)}–${num(r.to)}@${num(r.speed)}`).join(', ') || '-',
      (c.delta > 0 ? '+' : '') + c.delta.toFixed(1),
    ]))
    : 'Không có cảnh nào thay đổi timing.');
  out.push(`Tổng: ${oldDur.toFixed(1)} s → ${newDur.toFixed(1)} s`, '');
  out.push(comments.length
    ? table(['id', 'scene', 't', 'text'], comments.map(c => [c.id, c.sceneId, c.t.toFixed(2), c.text.slice(0, 60).replace(/\r?\n/g, '⏎')]))
    : 'Không có comment mở.');
  return out.join('\n');
}

function main(argv) {
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dry = argv.includes('--dry'), keepReview = argv.includes('--keep-review');
  const reviewPath = path.resolve(opt('--review') ?? path.join(REVIEW, 'review.json'));
  const timelinePath = path.resolve(opt('--timeline') ?? path.join(ROOT, 'timeline.json'));
  let r;
  try { r = mergeTimeline(reviewPath, timelinePath, { dry, keepReview }); }
  catch (e) { console.error(e.errors ? e.message : `apply: ${e.message}`); process.exit(1); }
  console.log(report(r));
  console.log('');
  if (dry) console.log('--dry: không ghi file nào.');
  else if (keepReview) console.log(`Timing đã áp dụng vào ${timelinePath}. --keep-review: review.timing giữ nguyên — đặt review.timing = {} để tránh áp dụng hai lần.`);
  else console.log(`Timing đã áp dụng vào ${timelinePath}; review.timing đã đặt về {} (rev tăng) để lần chạy sau không áp dụng hai lần.`);
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
