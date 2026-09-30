// Film engine: reads timeline.json, builds each scene once, and exposes a pure
// render(t) that render.mjs steps frame by frame. Open film.html?play for a live preview
// (?t=42 starts at 42 s).
const stage = document.getElementById('stage');
const SCENES = [];

// Entry transitions. `inner` is the scene's own root; the previous scene gets the matching exit.
const ENTER = {
  cut: { d: 0 },
  iris: {
    d: 0.7,
    enter: (s, p, o) => { s.root.style.clipPath = `circle(${Ease.inOutCubic(p) * 2300}px at ${o.x ?? 960}px ${o.y ?? 540}px)`; },
    exit: (s, p) => tf(s.root, { s: 1 - 0.05 * p }),
  },
  wipe: {
    d: 0.65,
    enter: (s, p) => { const e = Ease.inOutCubic(p) * 2600; s.root.style.clipPath = `polygon(${-700 + e}px 0, ${e}px 0, ${e - 700}px 1080px, ${-1400 + e}px 1080px, -1400px 1080px, -700px 0)`; },
    exit: (s, p) => tf(s.root, { x: -120 * Ease.inOutCubic(p) }),
  },
  slide: {
    d: 0.7,
    enter: (s, p) => tf(s.root, { x: (1 - Ease.inOutExpo(p)) * W }),
    exit: (s, p) => tf(s.root, { x: -Ease.inOutExpo(p) * W * 0.45, s: 1 - 0.08 * p, o: 1 - 0.6 * p }),
  },
  rise: {
    d: 0.7,
    enter: (s, p) => { tf(s.root, { y: (1 - Ease.inOutExpo(p)) * H }); s.root.style.borderRadius = `${(1 - p) * 60}px`; },
    exit: (s, p) => tf(s.root, { y: -Ease.inOutExpo(p) * H * 0.3, s: 1 - 0.1 * p, o: 1 - 0.7 * p }),
  },
  zoom: {
    d: 0.6,
    enter: (s, p) => tf(s.root, { s: lerp(1.35, 1, Ease.outCubic(p)), o: Ease.outCubic(p) }),
    exit: (s, p) => tf(s.root, { s: 1 + 0.5 * Ease.inCubic(p), o: 1 - p, blur: 10 * p }),
  },
  shrink: {
    d: 0.8,
    enter: (s, p) => { const e = Ease.inOutCubic(p); s.root.style.clipPath = `inset(${(1 - e) * 44}% ${(1 - e) * 40}% round ${(1 - e) * 80 + 0}px)`; },
    exit: (s, p) => tf(s.root, { s: 1 - 0.12 * Ease.inOutCubic(p), o: 1 - 0.5 * p }),
  },
};

function resetRoot(root) { root.style.transform = ''; root.style.clipPath = ''; root.style.opacity = ''; root.style.filter = ''; root.style.borderRadius = ''; }

// grain: a static noise tile, shifted per frame
function buildGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), img = g.createImageData(256, 256), r = rng(7);
  for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  const d = el('div', '', stage); d.id = 'grain';
  css(d, { backgroundImage: `url(${c.toDataURL()})` });
  el('div', '', stage).id = 'vignette';
  return d;
}

async function boot() {
  const tl = await (await fetch('timeline.json')).json();
  // one title line + voice-over lines ({ at, dur, text }, `at` in scene-local source seconds)
  const nar = await (await fetch('narration.json')).json();
  const man = await (await fetch('voice/manifest.json')).json().catch(() => ({ lines: {} }));
  const lay = Timing.layout(tl, {});
  for (const [i, s] of tl.scenes.entries()) {
    const def = SCENE_DEFS[s.id] || { // placeholder while a scene is being written
      build: (r, c) => { css(r, { background: '#222' }); el('div', 'center display', r, s.id).style.fontSize = '120px'; },
      update: () => {},
    };
    const { start, outDur: dur, toSource } = lay.scenes[i];
    const root = el('div', 'scene', stage);
    root.dataset.id = s.id;
    const inner = el('div', 'inner', root);
    const n = nar.scenes.find(x => x.id === s.id) || {};
    const ats = [].concat(n.at ?? []);
    // words: [{ w, s }] with s = the word's start in scene-local SOURCE seconds (see lib.js cue())
    const vo = (man.lines[s.id] || []).map((l, k) => {
      const at = ats[k] ?? 0, o = lay.scenes[i].toOutput(at);
      return { at, dur: l.dur, text: l.text, words: (l.words || []).map(x => ({ w: x.w, s: toSource(o + x.t) })) };
    });
    const ctx = { id: s.id, start, dur, root, inner, index: i, title: n.title || '', vo };
    def.build(inner, ctx);
    SCENES.push({ ...ctx, ctx, toSource, def, enter: def.enter || 'cut', enterOpts: def.enterOpts || {} });
  }
  window.DUR = lay.dur;
  // retime live (review app): new starts/durations/maps, same DOM
  window.setTiming = (overrides = {}) => {
    const l = Timing.layout(tl, overrides);
    SCENES.forEach((s, i) => {
      const { start, outDur: dur, toSource } = l.scenes[i];
      Object.assign(s, { start, dur, toSource });
      Object.assign(s.ctx, { start, dur });
    });
    return (window.DUR = l.dur);
  };
  const grain = buildGrain();
  window.render = t => {
    const fi = Math.floor(t * 60);
    grain.style.transform = `translate(${(fi * 37) % 60 - 30}px, ${(fi * 53) % 60 - 30}px)`;
    SCENES.forEach((s, i) => {
      const next = SCENES[i + 1];
      const nd = next ? ENTER[next.enter].d : 0;
      const end = s.start + s.dur;
      const visible = t >= s.start && t < end + nd;
      s.root.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      s.root.style.zIndex = i + 1;
      resetRoot(s.root);
      const lt = t - s.start; // output time; transitions stay unwarped
      const E = ENTER[s.enter];
      if (E.enter && lt < E.d) E.enter(s, lt / E.d, s.enterOpts);
      if (next && t >= end && ENTER[next.enter].exit) ENTER[next.enter].exit(s, (t - end) / nd);
      s.def.update(s.toSource(lt), s);
    });
  };
  await document.fonts.ready;
  await Promise.all([...document.images].map(im => (im.complete ? im.decode().catch(() => {}) : new Promise(r => { im.onload = im.onerror = r; }))));
  const q = new URLSearchParams(location.search);
  if (q.has('play')) {
    const t0 = performance.now() - (Number(q.get('t')) || 0) * 1000;
    const loop = () => { window.render(((performance.now() - t0) / 1000) % window.DUR); requestAnimationFrame(loop); };
    loop();
  } else window.render(Number(q.get('t')) || 0);
}
window.ready = boot();
