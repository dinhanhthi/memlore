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
