// Finale: themes & customization on one fixed layout, open source + free, and the outro.

// the looks, in the order they are spoken; ['shot', design system, mode]
const THEMES = [
  ['clay-dark', 'Clay', 'Dark'], ['clay-light', 'Clay', 'Light'], ['clean-light', 'Clean', 'Light'], ['clean-dark', 'Clean', 'Dark'],
  ['sig-light', 'Signature', 'Light'], ['sig-deep', 'Signature', 'Deep'], ['sig-soft', 'Signature', 'Soft'], ['sig-lumen', 'Signature', 'Lumen'],
];
const ACCENTS = [['accent-orange', '#f59e0b'], ['accent-violet', '#8b5cf6'], ['accent-rose', '#f43f5e'], ['accent-emerald', '#10b981']];
const LAYOUTS = ['layout-content-left', 'layout-sidebar-content', 'clay-dark'];
const SYSTEMS = [['Clay', '#e0a67a'], ['Clean', '#9ec5fe'], ['Signature', '#a58bff']];
// frame geometry: 1440×900 screenshot shown at FW×FH
const FX = 330, FY = 240, FW = 1260, FH = 787.5, K = FW / 1440;
const SPEED = 0.7; // the scene plays at 0.7x (timeline.json): one output second is 0.7 source seconds
const OUT = x => x * SPEED; // output seconds -> source seconds, for the reveal / hold lengths below

scene('themes', {
  enter: 'iris', enterOpts: { x: 960, y: 600 },
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b33', '#a58bff33', '#45d6c822', '#ff759722'], 141);
    c.cap = title(root, c.title, { y: 70, size: 82 });
    c.frame = el('div', 'abs', root); place(c.frame, FX, FY, FW, FH);
    css(c.frame, { borderRadius: '22px', overflow: 'hidden', boxShadow: '0 50px 120px #000c, 0 0 0 1px #ffffff22' });
    const layer = (src) => { const d = el('div', 'abs', c.frame); css(d, { inset: 0, backgroundImage: `url(../assets/shots/free-style/${src}.jpg)`, backgroundSize: 'cover' }); return d; };
    c.base = layer('clay-dark');
    // the base shot holds through "in countless combinations"; the steps below start only at "Three"
    const th = (src) => ({ src, kind: 'theme' });
    c.steps = [
      th('clay-light'), th('clean-dark'), th('sig-soft'), // "Three design systems": Clay, Clean, Signature
      th('sig-light'), th('sig-deep'), // "light and dark"
      ...ACCENTS.map(([src]) => ({ src, kind: 'accent' })),
      ...LAYOUTS.map((src) => ({ src, kind: 'layout' })),
    ].map(d => ({ ...d, el: layer(d.src) }));
    // icon swatches (left rail): design system, light/dark, accent, layout, fonts
    c.rail = el('div', 'abs col', root); place(c.rail, 40, 330, 250); css(c.rail, { gap: '34px' });
    const row = () => { const r = el('div', 'flex', c.rail); css(r, { gap: '10px', justifyContent: 'center' }); return r; };
    const tile = (r, inner) => { const d = el('div', 'flex', r, inner); css(d, { width: '52px', height: '52px', justifyContent: 'center', borderRadius: '14px', border: '1px solid var(--line-2)' }); d.querySelector('svg')?.setAttribute('style', 'width:28px;height:28px'); return d; };
    const dsRow = row(); c.rows = [dsRow];
    c.dsTiles = SYSTEMS.map(([, col]) => tile(dsRow, svgIcon('palette', col, 2)));
    const modeRow = row(); c.rows.push(modeRow);
    c.modeTiles = [['sun', '#f3a73b'], ['moon', '#c9b6ff']].map(([ic, col]) => tile(modeRow, svgIcon(ic, col, 2)));
    const accRow = row(); c.rows.push(accRow);
    c.accTiles = ACCENTS.map(([, col]) => { const d = tile(accRow, ''); css(d, { width: '44px', height: '44px', borderRadius: '50%', background: col }); return d; });
    const layRow = row(); c.rows.push(layRow);
    c.layTiles = LAYOUTS.map(() => tile(layRow, svgIcon('layout-panel-left', 'var(--cream)', 2)));
    const fontRow = row(); c.rows.push(fontRow);
    c.fontTile = tile(fontRow, svgIcon('type', 'var(--cream)', 2));
    // closing wall
    c.wall = THEMES.map(([s, sys, mode], i) => {
      const w = el('div', 'abs', root); place(w, 90 + (i % 4) * 440, 235 + Math.floor(i / 4) * 330, 420, 262.5);
      css(w, { borderRadius: '14px', overflow: 'hidden', backgroundImage: `url(../assets/shots/free-style/${s}.jpg)`, backgroundSize: 'cover', boxShadow: '0 24px 50px #000b' });
      const pill = el('div', 'abs chip', w, `${sys} · ${mode}`); css(pill, { left: '16px', bottom: '14px', fontSize: '19px', padding: '6px 16px', background: '#0d0d0dd1' });
      return w;
    });
    // v2 tally badges under the wall
    c.tally = el('div', 'abs flex', root); place(c.tally, 0, 925, W); css(c.tally, { gap: '18px', justifyContent: 'center' });
    c.badges = ['3 design systems', '8 looks', '6+ accents', '3 layouts', 'Aa fonts'].map(tx => el('div', 'chip', c.tally, tx));
  },
  update(t, c) {
    c.bg.update(t);
    const A = (ph) => cue(c, ph, 0, 1); // spoken word, scene-local source seconds
    titleIn(c.cap, t, 0.2);
    // theme toggle sits at (1383, 20) in app CSS px; the "New Entry" accent button at (70, 72)
    const TX = 1383 * K, TY = 20 * K, AX = 70 * K, AY = 72 * K;
    // The phrases stay at speaking speed. Each group's steps begin with the phrase and
    // finish in the silence after it, wipe included, before the next phrase starts.
    const spread = (t0, t1, n) => {
      if (n <= 1) return [t0];
      const end = Math.max(t0, t1), step = (end - t0) / (n - 1);
      return Array.from({ length: n }, (_, i) => t0 + step * i);
    };
    const sysT = spread(A('Three'), A('light') - OUT(1.54), 3);
    const modeTm = [A('light'), A('accent') - OUT(1.22)];
    const accT = spread(A('accent'), A('layouts') - OUT(0.82), 4);
    const layT = spread(A('layouts'), A('fonts') + OUT(1.05), 3);
    const at = [...sysT, ...modeTm, ...accT, ...layT];
    const FN = layT[2];
    // wall follows the last layout. Z < 1 only if that leaves less than OUT(4.1) of the scene.
    const Z = clamp((c.dur * SPEED - 0.15 - FN) / OUT(4.1), 0.45, 1), O = x => OUT(x * Z);
    c.steps.forEach((st, i) => {
      const a = at[i];
      const wipe = st.kind === 'layout' ? 0.85 : st.kind === 'accent' ? 0.55 : 0.9; // output seconds
      if (st.kind === 'layout') { const p = ep(t, a, a + OUT(wipe), 'inOutExpo'); st.el.style.display = p > 0 ? 'block' : 'none'; st.el.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; return; }
      const p = ep(t, a, a + OUT(wipe), 'inOutCubic'), [x, y] = st.kind === 'accent' ? [AX, AY] : [TX, TY];
      st.el.style.display = p > 0 ? 'block' : 'none'; st.el.style.clipPath = `circle(${p * 1600}px at ${x}px ${y}px)`;
    });
    // the frame comes in on "And make it yours"; the demo style itself stays put until "Three".
    // the wall follows the last layout, once that wipe has landed.
    const S0 = cue(c, 'And', 0, 0.7);
    const W0 = FN + O(1.1), wallP = ep(t, W0, W0 + O(0.8), 'inOutCubic');
    riseIn(c.frame, t, S0 - 0.2, 0.8, 120, { s: lerp(1, 0.33, wallP), o: ep(t, S0 - 0.2, S0 + 0.4) * (1 - ep(t, W0 + O(0.3), W0 + O(0.7))) });
    // swatches light up on their spoken word
    const on = (d, act) => { d.style.background = act ? 'var(--gold)' : 'var(--ink-3)'; d.style.color = act ? '#2a1a05' : 'var(--cream)'; const sv = d.querySelector('svg'); if (sv) { sv.dataset.c ??= sv.getAttribute('stroke'); sv.setAttribute('stroke', act ? '#2a1a05' : sv.dataset.c); } };
    // each left-hand row appears with the phrase it belongs to
    const fontsAt = A('fonts');
    const TM = { three: sysT[0], clean: sysT[1], sig: sysT[2], light: modeTm[0], dark: modeTm[1], accent: accT[0], layouts: layT[0], fonts: fontsAt };
    const RA = [TM.three, TM.light, TM.accent, TM.layouts, TM.fonts], railO = 1 - ep(t, W0 + O(0.2), W0 + O(0.6));
    c.rows.forEach((r, i) => riseIn(r, t, RA[i] - OUT(0.3), 0.4, 30, { o: ep(t, RA[i] - OUT(0.3), RA[i] + 0.1) * railO }));
    const cur = k => c.steps.reduce((n, st, i) => (st.kind === k && t >= at[i] ? n + 1 : n), 0); // steps reached of a kind
    const ds = t >= TM.three ? (t >= TM.sig ? 2 : t >= TM.clean ? 1 : 0) : -1;
    c.dsTiles.forEach((d, i) => { const act = ds === i; d.style.background = act ? 'var(--ink-4)' : 'var(--ink-3)'; d.style.outline = act ? '3px solid var(--gold)' : 'none'; tf(d, { s: act ? 1.12 : 1 }); });
    c.modeTiles.forEach((d, i) => { on(d, i ? t >= TM.dark : t >= TM.light && t < TM.dark); });
    const ac = cur('accent') - 1, ly = cur('layout') - 1;
    c.accTiles.forEach((d, i) => { d.style.outline = ac === i ? '3px solid var(--cream)' : 'none'; tf(d, { s: ac === i ? 1.15 : 1 }); });
    c.layTiles.forEach((d, i) => on(d, ly === i));
    on(c.fontTile, t >= fontsAt);
    // wall of looks, popping one by one, then the tally badges. The scene runs long enough that Z stays 1
    // and the finished wall holds before the cut.
    c.wall.forEach((d, i) => { d.style.display = t > W0 + O(0.6) ? 'block' : 'none'; popIn(d, t, W0 + O(0.7 + i * 0.13), 0.5, { y: bob(t, i, 6) }); });
    c.badges.forEach((b, i) => popIn(b, t, W0 + O(1.9 + i * 0.12), 0.4));
  },
});

scene('open', {
  enter: 'rise',
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b33', '#a58bff33', '#45d6c822'], 151);
    c.items = ['opensource', 'price', 'cross-platforms'].map((st, i) => {
      const box = el('div', 'abs col', root); place(box, 110 + i * 590, 230, 520); css(box, { alignItems: 'center', textAlign: 'center' });
      // same height for all three stickers, bottom-aligned in a fixed slot
      const slot = el('div', 'flex', box); css(slot, { height: '380px', width: '520px', alignItems: 'flex-end', justifyContent: 'center' });
      const im = el('img', '', slot); im.src = `../assets/stickers/sticker-${st}.png`; css(im, { height: '360px', width: 'auto', filter: 'drop-shadow(0 20px 30px #0009)', transformOrigin: '50% 100%' });
      const lab = el('div', 'display grad-gold', box, ['Open source', 'Free', 'Cross-platform'][i]); css(lab, { fontSize: '76px', marginTop: '36px', whiteSpace: 'nowrap', lineHeight: 1.25, paddingBottom: '0.16em' });
      return { box, im, lab };
    });
  },
  update(t, c) {
    c.bg.update(t);
    // stickers and their labels pop on "open source", "free" and "across all your devices"
    const CU = [cue(c, 'open source', 0, 2.3), cue(c, 'free', 0, 3.2), cue(c, 'across', 0, 4.06)];
    // the first sticker shows up right after "Best of all?" (its label still waits for the spoken word)
    c.items.forEach(({ im, lab }, i) => { const a = CU[i] - 0.1; popIn(im, t, i ? a : Math.min(a, voAt(c) + 0.5), 0.5, { y: bob(t, i, 8) }); riseIn(lab, t, a + 0.1, 0.5, 30); });
  },
});

scene('outro', {
  enter: 'iris', enterOpts: { x: 960, y: 400 },
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b55', '#a58bff33', '#ff759733'], 161);
    c.head = el('div', 'abs', root); place(c.head, 960 - 150, 110, 300, 300);
    c.heads = {};
    for (const n of ['default', 'left', 'right', 'top', 'down', 'top-left', 'top-right', 'down-left', 'down-right', 'straight']) {
      const im = el('img', 'abs', c.head); im.src = `../assets/head/${n}.png`; css(im, { inset: 0, width: '100%', height: '100%', filter: 'drop-shadow(0 26px 40px #0009)' }); c.heads[n] = im;
    }
    c.word = el('div', 'abs display', root, 'Memlore'); css(c.word, { left: 0, right: 0, top: '410px', textAlign: 'center', fontSize: '170px' });
    c.tag = el('div', 'abs display ital', root, 'A little life. <span class="grad-gold">A lasting story.</span>'); css(c.tag, { left: 0, right: 0, top: '620px', textAlign: 'center', fontSize: '58px', fontWeight: 400, color: 'var(--cream-2)', lineHeight: 1.25, paddingBottom: '0.12em' });
    c.btn = el('div', 'abs btn', root, `${svgIcon('download', '#2a1a05', 2.4)}Download Memlore`); place(c.btn, 960 - 185, 740); css(c.btn, { fontSize: '30px', padding: '20px 36px', borderRadius: '20px', boxShadow: '0 20px 50px #f3a73b55' }); c.btn.querySelector('svg').style.width = '30px';
    c.url = el('div', 'abs mono', root, 'memlore.app  ·  github.com/dinhanhthi/memlore'); css(c.url, { left: 0, right: 0, top: '880px', textAlign: 'center', fontSize: '34px', color: 'var(--cream-3)', letterSpacing: '0.04em' });
    c.cursor = el('div', 'abs', root); css(c.cursor, { width: '44px', height: '44px', zIndex: 20 });
    c.cursor.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    // party dogs on both sides, only after the download click
    c.sk = sticker(root, 'celebrate', 1450, 520, 320);
    c.sk2 = sticker(root, 'celebrate', 150, 520, 320); css(c.sk2, { scale: '-1 1' });
    const r = rng(77);
    c.conf = Array.from({ length: 70 }, (_, i) => { const d = el('div', 'abs', root); const w = 10 + r() * 12; place(d, 960, 780, w, w * 0.45); css(d, { background: ['#f3a73b', '#a58bff', '#ff7597', '#45d6c8', '#8fb34a', '#ffcf7a'][i % 6], borderRadius: '3px' }); return { d, a: -Math.PI / 2 + (r() - 0.5) * 2.4, v: 700 + r() * 700, sp: (r() - 0.5) * 1400 }; });
    c.black = el('div', 'abs', root); css(c.black, { inset: 0, background: '#000', zIndex: 40 });
  },
  update(t, c) {
    c.bg.update(t);
    // the Download button is there from the start; the click lands just after "today!" ends
    const CL = voEnd(c, 0, 5.1) + 0.15;
    // cursor path the head follows, then a click on the download button
    const path = [[1500, 900, 0.3], [1560, 180, 1.2], [360, 160, 2.2], [300, 820, 3.2], [960, 980, 4.1], [980, 790, CL - 0.2]];
    let cx = path[0][0], cy = path[0][1];
    for (let i = 1; i < path.length; i++) { const [x, y, at] = path[i], [px, py, pa] = path[i - 1]; if (t >= pa) { const q = ep(t, pa, at, 'inOutCubic'); cx = lerp(px, x, q); cy = lerp(py, y, q); } }
    css(c.cursor, { left: cx + 'px', top: cy + 'px', opacity: ep(t, 0.2, 0.5) * (1 - ep(t, CL + 1, CL + 1.4)) });
    tf(c.cursor, { s: t > CL - 0.1 && t < CL + 0.1 ? 0.8 : 1 });
    // pick the head frame from the cursor direction (like the app's "logo follows cursor")
    const dx = cx - 960, dy = cy - 260, ang = Math.atan2(dy, dx), dist = Math.hypot(dx, dy);
    const dirs = ['right', 'down-right', 'down', 'down-left', 'left', 'top-left', 'top', 'top-right'];
    let f = dirs[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
    if (t < 0.5 || dist < 160 || t > CL + 1.2) f = 'straight';
    for (const k in c.heads) c.heads[k].style.opacity = k === f ? 1 : 0;
    popIn(c.head, t, 0.1, 0.6, { y: bob(t, 0, 5) });
    riseIn(c.word, t, 0.3, 0.7, 60);
    riseIn(c.tag, t, cue(c, 'little', 0, 1.7) - 0.15, 0.6, 24);
    const press = t > CL - 0.1 && t < CL + 0.15;
    popIn(c.btn, t, 0.5, 0.5, { s: press ? 0.94 : 1 });
    riseIn(c.url, t, 1.3, 0.6, 20);
    c.conf.forEach(({ d, a, v, sp }) => {
      const u = t - CL; if (u < 0) { d.style.opacity = 0; return; }
      tf(d, { x: Math.cos(a) * v * u, y: Math.sin(a) * v * u + 900 * u * u, r: sp * u, o: 1 - prog(u, 1.4, 2.4) });
    });
    popIn(c.sk, t, CL + 0.15, 0.5, { y: bob(t), r: 6 });
    popIn(c.sk2, t, CL + 0.25, 0.5, { y: bob(t, 1), r: -6 });
    c.black.style.opacity = ep(t, c.dur - 1.1, c.dur, 'inCubic'); // fade to black over the last 1.1 s
  },
});
