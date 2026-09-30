// Shared timing maths for the free-style film, review app and apply tool.
// Classic script: sets globalThis.Timing (film.html loads it as <script>, Node via vm).
// A scene's `bars` is its authored SOURCE length; optional `speed`, `warp` and
// `beats` / `snap` time-warp it into an OUTPUT length. No fields = identity.
(function () {
  const SPEED_MIN = 0.25, SPEED_MAX = 4, BEAT = 0.5, BAR = 2;
  const TIMING_KEYS = ['beats', 'speed', 'warp', 'snap'];
  const beatLen = bpm => 60 / bpm;
  const barLen = bpm => 4 * 60 / bpm;

  const snapBeats = (sec, bpm = 120) => Math.max(1, Math.round(sec / beatLen(bpm)));
  const snapBars = (sec, bpm = 120) => Math.max(1, Math.round(sec / barLen(bpm)));

  // segments covering [0, srcDur]: gaps at base speed, ranges at their own speed
  function segments(scene, srcDur) {
    const speed = scene.speed ?? 1, segs = [];
    let s = 0, o = 0;
    const push = (to, v) => { if (to > s) { segs.push({ s0: s, s1: to, o0: o, v }); o += (to - s) / v; s = to; } };
    for (const r of scene.warp || []) { push(r.from, speed); push(r.to, r.speed); }
    push(srcDur, speed);
    return { segs, rawOutDur: o };
  }

  function sceneMap(scene, bpm = 120) {
    const srcDur = scene.bars * barLen(bpm), speed = scene.speed ?? 1;
    const outDurOf = raw => scene.beats != null ? scene.beats * beatLen(bpm)
      : scene.snap === 'bar' ? snapBars(raw, bpm) * barLen(bpm) : snapBeats(raw, bpm) * beatLen(bpm);
    if (speed === 1 && !(scene.warp && scene.warp.length)) {
      const id = t => t;
      return { srcDur, rawOutDur: srcDur, outDur: outDurOf(srcDur), toSource: id, toOutput: id };
    }
    const { segs, rawOutDur } = segments(scene, srcDur);
    // outside [0, srcDur] both maps extrapolate at base speed
    function toSource(o) {
      if (o < 0) return o * speed;
      if (o > rawOutDur) return srcDur + (o - rawOutDur) * speed;
      let g = segs[0];
      for (const x of segs) if (o >= x.o0) g = x; else break;
      return Math.min(g.s1, g.s0 + (o - g.o0) * g.v);
    }
    function toOutput(s) {
      if (s < 0) return s / speed;
      if (s > srcDur) return rawOutDur + (s - srcDur) / speed;
      let g = segs[0];
      for (const x of segs) if (s >= x.s0) g = x; else break;
      return g.o0 + (s - g.s0) / g.v;
    }
    return { srcDur, rawOutDur, outDur: outDurOf(rawOutDur), toSource, toOutput };
  }

  // base speed making rawOutDur === beats*BEAT, or null
  function fitSpeed(scene, beats, bpm = 120) {
    const srcDur = scene.bars * barLen(bpm), target = beats * beatLen(bpm);
    let covered = 0, rangeTime = 0;
    for (const r of scene.warp || []) { covered += r.to - r.from; rangeTime += (r.to - r.from) / r.speed; }
    if (target <= rangeTime) return null;
    const v = (srcDur - covered) / (target - rangeTime);
    return v >= SPEED_MIN && v <= SPEED_MAX ? v : null;
  }

  const speedOk = v => typeof v === 'number' && Number.isFinite(v) && v >= SPEED_MIN && v <= SPEED_MAX;

  // error strings, empty when the scene is valid
  function validate(scene, bpm = 120) {
    const errs = [];
    if (!(typeof scene.bars === 'number' && scene.bars > 0)) errs.push('bars must be a positive number');
    const srcDur = scene.bars * barLen(bpm);
    if (scene.speed != null && !speedOk(scene.speed)) errs.push(`speed ${scene.speed} outside [${SPEED_MIN}, ${SPEED_MAX}]`);
    if (scene.beats != null && !(Number.isInteger(scene.beats) && scene.beats > 0)) errs.push(`beats ${scene.beats} is not a positive integer`);
    if (scene.snap != null && scene.snap !== 'beat' && scene.snap !== 'bar') errs.push(`snap "${scene.snap}" is not beat or bar`);
    if (scene.warp != null && !Array.isArray(scene.warp)) { errs.push('warp must be an array'); return errs; }
    (scene.warp || []).forEach((r, i) => {
      const at = `warp[${i}]`;
      if (!(Number.isFinite(r.from) && Number.isFinite(r.to))) return errs.push(`${at} from/to must be finite numbers`);
      if (r.from >= r.to) errs.push(`${at} from >= to`);
      if (r.from < 0 || r.to > srcDur) errs.push(`${at} outside [0, ${srcDur}]`);
      if (!speedOk(r.speed)) errs.push(`${at} speed ${r.speed} outside [${SPEED_MIN}, ${SPEED_MAX}]`);
      const p = scene.warp[i - 1];
      if (p && Number.isFinite(p.from) && Number.isFinite(p.to)) {
        if (r.from < p.from) errs.push(`${at} unsorted (starts before warp[${i - 1}])`);
        else if (r.from < p.to) errs.push(`${at} overlaps warp[${i - 1}]`);
      }
    });
    return errs;
  }

  // timing keys in the override replace the scene's; an explicit null removes one
  function applyOverride(scene, ov) {
    const out = { ...scene };
    for (const k of TIMING_KEYS) if (ov && k in ov) { if (ov[k] === null) delete out[k]; else out[k] = ov[k]; }
    return out;
  }

  function layout(tl, overrides = {}) {
    const bpm = tl.bpm || 120;
    let start = 0;
    const scenes = tl.scenes.map(sc => {
      const s = applyOverride(sc, overrides[sc.id]);
      const m = sceneMap(s, bpm);
      const rec = { id: s.id, section: s.section, start, outDur: m.outDur, srcDur: m.srcDur, toSource: m.toSource, toOutput: m.toOutput, snap: s.snap || 'beat' };
      start += m.outDur;
      return rec;
    });
    return { scenes, dur: start };
  }

  const isIdentity = s => (s.speed == null || s.speed === 1) && !(s.warp && s.warp.length)
    && (s.beats == null || s.beats === s.bars * 4) && (s.snap == null || s.snap === 'beat');

  // new timeline with review timing written in; identity scenes lose their timing keys
  function mergeTiming(tl, timing) {
    const copy = JSON.parse(JSON.stringify(tl)), t = JSON.parse(JSON.stringify(timing || {}));
    copy.scenes = copy.scenes.map(sc => {
      const s = applyOverride(sc, t[sc.id]);
      if (isIdentity(s)) for (const k of TIMING_KEYS) delete s[k];
      const out = {};
      for (const k of ['id', 'bars', 'section', ...TIMING_KEYS]) if (k in s) out[k] = s[k];
      for (const k of Object.keys(s)) if (!(k in out)) out[k] = s[k];
      return out;
    });
    return copy;
  }

  globalThis.Timing = { sceneMap, snapBeats, snapBars, fitSpeed, validate, layout, mergeTiming, SPEED_MIN, SPEED_MAX, BEAT, BAR };
})();
