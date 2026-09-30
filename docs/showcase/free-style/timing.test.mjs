// node --test docs/showcase/free-style/timing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(read('timing.js'), sandbox);
const T = sandbox.Timing;
const FX = JSON.parse(read('timing-fixtures.json'));
// Frozen snapshot of the authored 17-scene timeline (no timing fields, 156 s). Tests with
// hard-coded starts/durations use it, so applying a real review to timeline.json cannot break them.
const TL = {
  bpm: 120,
  note: 'Scene lengths are in bars (4 beats, 2 s at 120 BPM). film.js and soundtrack.py both read this file, so cuts and musical hits stay locked.',
  scenes: [
    ['intro', 4, 'intro'], ['hook', 2, 'build'], ['local', 3, 'verse'], ['encrypt', 2, 'verse'],
    ['locks', 6, 'verse'], ['editor', 8, 'chorus'], ['find', 3, 'verse'], ['map', 6, 'verse'],
    ['aiIntro', 2, 'build'], ['aiCards', 13, 'chorus'], ['secondYou', 5, 'bridge'], ['mcp', 3, 'verse'],
    ['sync', 4, 'verse'], ['import', 2, 'build'], ['themes', 8, 'chorus'], ['open', 2, 'verse'],
    ['outro', 5, 'outro'],
  ].map(([id, bars, section]) => ({ id, bars, section })),
};
const REAL_TL = JSON.parse(read('timeline.json'));

// sandbox objects carry the sandbox's prototypes; normalise before deep compares
const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, msg, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b}`);
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

for (const c of FX.sceneMap) {
  test(`sceneMap: ${c.name}`, () => {
    const m = T.sceneMap(c.scene, c.bpm);
    near(m.srcDur, c.expect.srcDur, 'srcDur');
    near(m.rawOutDur, c.expect.rawOutDur, 'rawOutDur');
    near(m.outDur, c.expect.outDur, 'outDur');
    for (const [o, s] of c.expect.points) {
      near(m.toSource(o), s, `toSource(${o})`);
      near(m.toOutput(s), o, `toOutput(${s})`);
    }
  });

  test(`round-trip: ${c.name}`, () => {
    const m = T.sceneMap(c.scene, c.bpm);
    const r = rng(c.name.length * 7919 + 1);
    const lo = -2, hi = m.rawOutDur + 2;
    for (let i = 0; i < 1000; i++) {
      const x = lo + (hi - lo) * r();
      near(m.toOutput(m.toSource(x)), x, `round-trip ${x}`, 1e-9);
    }
  });
}

test('identity scene is exact, no float drift', () => {
  for (const bars of [1, 2, 3, 13]) {
    const m = T.sceneMap({ bars }, 120);
    assert.equal(m.outDur, bars * 2);
    for (const o of [-0.3, 0.1, 0.7, 1.9, 25.1]) {
      assert.equal(m.toSource(o), o);
      assert.equal(m.toOutput(o), o);
    }
  }
});

test('snapBeats / snapBars', () => {
  assert.equal(T.snapBeats(1.6), 3);
  assert.equal(T.snapBeats(0.1), 1);
  assert.equal(T.snapBars(6.4), 3);
  assert.equal(T.snapBars(0.5), 1);
  assert.equal(T.BEAT, 0.5);
  assert.equal(T.BAR, 2);
  assert.equal(T.SPEED_MIN, 0.25);
  assert.equal(T.SPEED_MAX, 4);
});

for (const c of FX.fitSpeed) {
  test(`fitSpeed: ${c.name}`, () => {
    const v = T.fitSpeed(c.scene, c.beats, c.bpm);
    if (c.expect === null) return assert.equal(v, null);
    near(v, c.expect, 'speed', 1e-9);
    near(T.sceneMap({ ...c.scene, speed: v }, c.bpm).rawOutDur, c.beats * 0.5, 'rawOutDur', 1e-9);
  });
}

for (const c of FX.validate) {
  test(`validate: ${c.name}`, () => {
    const errs = plain(T.validate(c.scene));
    assert.equal(errs.length, c.errors.length, JSON.stringify(errs));
    c.errors.forEach((frag, i) => assert.ok(errs[i].includes(frag), `${errs[i]} lacks "${frag}"`));
  });
}

test('layout of the baseline timeline matches the authored film', () => {
  const L = T.layout(TL);
  let start = 0;
  TL.scenes.forEach((s, i) => {
    const r = L.scenes[i];
    assert.equal(r.id, s.id);
    assert.equal(r.section, s.section);
    assert.equal(r.start, start);
    assert.equal(r.outDur, s.bars * 2);
    assert.equal(r.srcDur, s.bars * 2);
    assert.equal(r.snap, 'beat');
    assert.equal(r.toSource(1.3), 1.3);
    start += s.bars * 2;
  });
  assert.equal(L.dur, 156);
});

test('real timeline.json: invariants hold whatever timing it carries', () => {
  const L = T.layout(REAL_TL);
  assert.equal(L.scenes.length, REAL_TL.scenes.length);
  let start = 0;
  REAL_TL.scenes.forEach((s, i) => {
    assert.deepEqual(plain(T.validate(s, REAL_TL.bpm)), [], s.id);
    assert.equal(L.scenes[i].id, s.id);
    near(L.scenes[i].start, start, `${s.id} start`, 1e-9);
    start += L.scenes[i].outDur;
  });
  near(L.dur, start, 'dur', 1e-9);
});

test('layout applies overrides; null removes a key', () => {
  const tl = { bpm: 120, scenes: [{ id: 'a', bars: 2, speed: 2 }, { id: 'b', bars: 3 }] };
  const L = T.layout(tl, { a: { speed: null, beats: 2 }, b: { speed: 2 } });
  assert.deepEqual(plain(L.scenes.map(s => [s.start, s.outDur])), [[0, 1], [1, 3]]);
  assert.equal(L.dur, 4);
  assert.equal(L.scenes[0].toSource(0.5), 0.5);
});

test('mergeTiming writes fields, strips identity, leaves input untouched', () => {
  const tl = { bpm: 120, note: 'n', scenes: [
    { id: 'a', bars: 2, section: 'x', speed: 2 },
    { id: 'b', bars: 3, section: 'y' },
    { id: 'c', bars: 1, section: 'z', beats: 4, snap: 'beat', warp: [] },
  ] };
  const timing = { a: { speed: 1 }, b: { snap: 'bar', warp: [{ from: 0, to: 1, speed: 2 }], speed: 0.5, beats: 20 } };
  const before = JSON.stringify(tl), timingBefore = JSON.stringify(timing);
  const out = plain(T.mergeTiming(tl, timing));
  assert.equal(JSON.stringify(tl), before);
  assert.equal(JSON.stringify(timing), timingBefore);
  assert.equal(out.note, 'n');
  assert.deepEqual(out.scenes[0], { id: 'a', bars: 2, section: 'x' });
  assert.deepEqual(Object.keys(out.scenes[1]), ['id', 'bars', 'section', 'beats', 'speed', 'warp', 'snap']);
  assert.deepEqual(out.scenes[2], { id: 'c', bars: 1, section: 'z' });
  // result is a deep copy: editing it cannot reach the caller's timing
  const merged = T.mergeTiming(tl, timing);
  merged.scenes[1].warp[0].speed = 3;
  assert.equal(timing.b.warp[0].speed, 2);
});

test('layout(mergeTiming(tl, T)) === layout(tl, T)', () => {
  const timing = { editor: { speed: 2 }, map: { warp: [{ from: 1, to: 5, speed: 0.5 }], snap: 'bar' }, outro: { beats: 12 } };
  const a = T.layout(T.mergeTiming(TL, timing)), b = T.layout(TL, timing);
  assert.deepEqual(plain(a.scenes.map(s => [s.id, s.start, s.outDur, s.snap])), plain(b.scenes.map(s => [s.id, s.start, s.outDur, s.snap])));
  assert.equal(a.dur, b.dur);
  assert.equal(b.dur, 156 - 8 + 4 - 4);
});

// ---- review/apply.mjs ----
// dynamic import keeps the maths tests above independent of the apply tool
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const apply = () => import('./review/apply.mjs');

function fixture(timing, comments = []) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-'));
  const tlPath = join(dir, 'timeline.json'), rvPath = join(dir, 'review.json');
  writeFileSync(tlPath, JSON.stringify(TL, null, 2) + '\n');
  writeFileSync(rvPath, JSON.stringify({ schemaVersion: 1, film: 'free-style', rev: 3, updatedAt: 'x', timing, comments }, null, 2) + '\n');
  return { dir, tlPath, rvPath, tl: () => readFileSync(tlPath, 'utf8'), rv: () => JSON.parse(readFileSync(rvPath, 'utf8')), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const comment = (id, sceneId, sourceT, status = 'open') =>
  ({ id, sceneId, sourceT, x: 10, y: 10, text: 'fix\nthis', status, reply: null, createdAt: 'x', resolvedAt: null });

test('apply: merge writes fields and resets review.timing', async () => {
  const { mergeTimeline } = await apply();
  const f = fixture({ editor: { speed: 2 }, map: { warp: [{ from: 1, to: 5, speed: 0.5 }] } });
  try {
    const r = mergeTimeline(f.rvPath, f.tlPath);
    const tl = JSON.parse(f.tl());
    assert.equal(f.tl(), JSON.stringify(tl, null, 2) + '\n');
    assert.deepEqual(Object.keys(tl), ['bpm', 'note', 'scenes']);
    assert.deepEqual(tl.scenes.find(s => s.id === 'editor'), { id: 'editor', bars: 8, section: 'chorus', speed: 2 });
    assert.deepEqual(tl.scenes.find(s => s.id === 'map').warp, [{ from: 1, to: 5, speed: 0.5 }]);
    assert.deepEqual(plain(r.changed.map(c => c.id)), ['editor', 'map']);
    const rv = f.rv();
    assert.deepEqual(rv.timing, {});
    assert.equal(rv.rev, 4);
  } finally { f.done(); }
});

test('apply: timing back to identity strips fields', async () => {
  const { mergeTimeline } = await apply();
  const f = fixture({ editor: { speed: 2, beats: 8 } });
  try {
    mergeTimeline(f.rvPath, f.tlPath);
    const rv = f.rv();
    writeFileSync(f.rvPath, JSON.stringify({ ...rv, timing: { editor: { speed: 1, beats: null } } }));
    mergeTimeline(f.rvPath, f.tlPath);
    assert.deepEqual(JSON.parse(f.tl()).scenes.find(s => s.id === 'editor'), { id: 'editor', bars: 8, section: 'chorus' });
  } finally { f.done(); }
});

test('apply: second run is a no-op', async () => {
  const { mergeTimeline } = await apply();
  const f = fixture({ outro: { beats: 12 } });
  try {
    mergeTimeline(f.rvPath, f.tlPath);
    const tl1 = f.tl(), rv1 = f.rv();
    const r = mergeTimeline(f.rvPath, f.tlPath);
    assert.equal(f.tl(), tl1);
    assert.deepEqual(f.rv(), rv1);
    assert.deepEqual(rv1.timing, {});
    assert.equal(r.changed.length, 0);
  } finally { f.done(); }
});

test('apply: dry run leaves both files untouched', async () => {
  const { mergeTimeline } = await apply();
  const f = fixture({ editor: { speed: 2 } });
  try {
    const tl0 = f.tl(), rv0 = readFileSync(f.rvPath, 'utf8');
    const r = mergeTimeline(f.rvPath, f.tlPath, { dry: true });
    assert.equal(f.tl(), tl0);
    assert.equal(readFileSync(f.rvPath, 'utf8'), rv0);
    assert.equal(r.next.scenes.find(s => s.id === 'editor').speed, 2);
  } finally { f.done(); }
});

test('apply: keepReview leaves review.json untouched', async () => {
  const { mergeTimeline } = await apply();
  const f = fixture({ editor: { speed: 2 } });
  try {
    const rv0 = readFileSync(f.rvPath, 'utf8');
    mergeTimeline(f.rvPath, f.tlPath, { keepReview: true });
    assert.equal(readFileSync(f.rvPath, 'utf8'), rv0);
    assert.equal(JSON.parse(f.tl()).scenes.find(s => s.id === 'editor').speed, 2);
  } finally { f.done(); }
});

for (const [name, timing, frag] of [
  ['overlapping ranges', { map: { warp: [{ from: 1, to: 5, speed: 2 }, { from: 4, to: 6, speed: 2 }] } }, 'overlaps'],
  ['unknown scene', { nope: { speed: 2 } }, 'unknown scene'],
  ['unknown key', { editor: { bars: 3 } }, 'unknown keys'],
  ['range outside source', { hook: { warp: [{ from: 1, to: 9, speed: 2 }] } }, 'outside'],
]) {
  test(`apply: invalid review (${name}) throws and writes nothing`, async () => {
    const { mergeTimeline } = await apply();
    const f = fixture(timing);
    try {
      const tl0 = f.tl(), rv0 = readFileSync(f.rvPath, 'utf8');
      assert.throws(() => mergeTimeline(f.rvPath, f.tlPath), e => Array.isArray(e.errors) && e.errors.some(m => m.includes(frag)));
      assert.equal(f.tl(), tl0);
      assert.equal(readFileSync(f.rvPath, 'utf8'), rv0);
    } finally { f.done(); }
  });
}

test('apply: open comment t uses the new layout', async () => {
  const { mergeTimeline } = await apply();
  // editor starts at 34 s; intro 8 s -> 4 beats (2 s) shifts it to 28 s; editor at 2x maps source 4 s -> 2 s
  const f = fixture({ intro: { speed: 4, beats: 4 }, editor: { speed: 2 } },
    [comment('c1', 'editor', 4), comment('c2', 'hook', 1, 'resolved')]);
  try {
    const r = mergeTimeline(f.rvPath, f.tlPath, { dry: true });
    assert.deepEqual(plain(r.comments.map(c => [c.id, c.sceneId, c.t])), [['c1', 'editor', 30]]);
  } finally { f.done(); }
});
