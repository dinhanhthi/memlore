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

// labels of the right-hand rail: [name, line 2, small caps subtitle, swatch colour]
const LAYOUT_NAMES = [['Content left', 'content, list, sidebar'], ['Sidebar first', 'sidebar, content, list'], ['Classic', 'sidebar, list, content']];
const ACCENT_NAMES = ['Amber', 'Violet', 'Rose', 'Emerald'];

scene('themes', {
  enter: 'iris', enterOpts: { x: 960, y: 600 },
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b33', '#a58bff33', '#45d6c822', '#ff759722'], 141);
    c.cap = title(root, c.title, { y: 70, size: 82 });
    c.frame = el('div', 'abs', root); place(c.frame, FX, FY, FW, FH);
    css(c.frame, { borderRadius: '22px', overflow: 'hidden', boxShadow: '0 50px 120px #000c, 0 0 0 1px #ffffff22' });
    const layer = (src) => { const d = el('div', 'abs', c.frame); css(d, { inset: 0, backgroundImage: `url(../assets/shots/free-style/${src}.jpg)`, backgroundSize: 'cover' }); return d; };
    c.base = layer('clay-dark');
    // each step reveals a screenshot on top of the last, [shot, kind, cue phrase, offset in output s, label]; later steps paint over earlier ones
    const th = (src, sys, mode) => ({ src, kind: 'theme', label: [sys, mode, 'DESIGN SYSTEM · MODE', SYSTEMS.find(x => x[0] === sys)[1]] });
    c.steps = [
      [th('clay-light', 'Clay', 'Light'), 'exactly', 0], [th('clean-dark', 'Clean', 'Dark'), 'like', 0], [th('sig-deep', 'Signature', 'Deep'), 'countless', 0], [th('sig-light', 'Signature', 'Light'), 'combinations', 0], // "looks exactly the way you like, in countless combinations"
      [th('clay-dark', 'Clay', 'Dark'), 'Three', -0.1], [th('clean-dark', 'Clean', 'Dark'), 'systems', -0.15], [th('sig-soft', 'Signature', 'Soft'), 'systems', 0.4], // "Three design systems": Clay -> Clean -> Signature
      [th('sig-light', 'Signature', 'Light'), 'light', -0.05], [th('sig-deep', 'Signature', 'Deep'), 'dark', -0.05], // "light and dark"
      ...ACCENTS.map(([src, col], i) => [{ src, kind: 'accent', label: [ACCENT_NAMES[i], 'on any theme', 'ACCENT COLOUR', col] }, ...[['accent', -0.05], ['colours', 0], ['colours', 0.35], ['layouts', -0.2]][i]]), // "accent colours"
      ...LAYOUTS.map((src, i) => [{ src, kind: 'layout', label: [LAYOUT_NAMES[i][0], LAYOUT_NAMES[i][1], 'LAYOUT', '#f5eee4'] }, ...[['layouts', 0], ['and fonts', 0], ['fonts', -0.2]][i]]), // "layouts"
    ].map(([d, ph, off]) => ({ ...d, el: layer(d.src), ph, off }));
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
    // right-hand label rail: name, second line, small caps subtitle, swatch
    c.lab = el('div', 'abs', root); place(c.lab, 1618, 560, 290);
    c.labSw = el('div', 'abs', c.lab); css(c.labSw, { left: 0, top: '-44px', width: '28px', height: '28px', borderRadius: '50%', border: '1px solid var(--line-2)' });
    c.labName = el('div', 'display', c.lab); css(c.labName, { fontSize: '56px', lineHeight: '1.05', color: 'var(--cream)' });
    c.labMode = el('div', 'display grad-gold', c.lab); css(c.labMode, { fontSize: '40px', lineHeight: '1.1' });
    c.labSub = el('div', 'mono', c.lab); css(c.labSub, { marginTop: '22px', fontSize: '19px', letterSpacing: '0.2em', color: 'var(--cream-3)' });
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
    const A = (ph, off = 0) => cue(c, ph, 0, 0.7 + 1) + OUT(off); // a spoken word, shifted by output seconds
    titleIn(c.cap, t, 0.2);
    // theme toggle sits at (1383, 20) in app CSS px; the "New Entry" accent button at (70, 72)
    const TX = 1383 * K, TY = 20 * K, AX = 70 * K, AY = 72 * K;
    const at = c.steps.map(st => A(st.ph, st.off));
    c.steps.forEach((st, i) => {
      const a = at[i];
      if (st.kind === 'layout') { const p = ep(t, a, a + OUT(0.45), 'inOutExpo'); st.el.style.display = p > 0 ? 'block' : 'none'; st.el.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; return; }
      const p = ep(t, a, a + OUT(st.kind === 'accent' ? 0.3 : 0.5), 'inOutCubic'), [x, y] = st.kind === 'accent' ? [AX, AY] : [TX, TY];
      st.el.style.display = p > 0 ? 'block' : 'none'; st.el.style.clipPath = `circle(${p * 1600}px at ${x}px ${y}px)`;
    });
    // the frame comes in on "And make it yours"; the closing wall comes 1.3 s after "fonts" (v2 timing)
    const S0 = cue(c, 'And', 0, 0.7), FN = A('fonts');
    const W0 = FN + OUT(1.3), wallP = ep(t, W0, W0 + OUT(0.8), 'inOutCubic');
    riseIn(c.frame, t, S0 - 0.2, 0.8, 120, { s: lerp(1, 0.33, wallP), o: ep(t, S0 - 0.2, S0 + 0.4) * (1 - ep(t, W0 + OUT(0.3), W0 + OUT(0.7))) });
    // swatches light up on their spoken word
    const on = (d, act) => { d.style.background = act ? 'var(--gold)' : 'var(--ink-3)'; d.style.color = act ? '#2a1a05' : 'var(--cream)'; const sv = d.querySelector('svg'); if (sv) { sv.dataset.c ??= sv.getAttribute('stroke'); sv.setAttribute('stroke', act ? '#2a1a05' : sv.dataset.c); } };
    const T = { three: A('Three', -0.1), clean: A('systems', -0.15), sig: A('systems', 0.4), light: A('light', -0.05), dark: A('dark', -0.05), accent: A('accent', -0.05), layouts: A('layouts'), fonts: FN };
    const RA = [T.three, T.light, T.accent, T.layouts, T.fonts], railO = 1 - ep(t, W0 + OUT(0.2), W0 + OUT(0.6));
    c.rows.forEach((r, i) => riseIn(r, t, RA[i] - OUT(0.3), 0.4, 30, { o: ep(t, RA[i] - OUT(0.3), RA[i] + 0.1) * railO }));
    const cur = k => c.steps.reduce((n, st, i) => (st.kind === k && t >= at[i] ? n + 1 : n), 0); // steps reached of a kind
    const ds = t >= T.three ? (t >= T.sig ? 2 : t >= T.clean ? 1 : 0) : -1;
    c.dsTiles.forEach((d, i) => { const act = ds === i; d.style.background = act ? 'var(--ink-4)' : 'var(--ink-3)'; d.style.outline = act ? '3px solid var(--gold)' : 'none'; tf(d, { s: act ? 1.12 : 1 }); });
    c.modeTiles.forEach((d, i) => { on(d, i ? t >= T.dark : t >= T.light && t < T.dark); });
    const ac = cur('accent') - 1, ly = cur('layout') - 1;
    c.accTiles.forEach((d, i) => { d.style.outline = ac === i ? '3px solid var(--cream)' : 'none'; tf(d, { s: ac === i ? 1.15 : 1 }); });
    c.layTiles.forEach((d, i) => on(d, ly === i));
    on(c.fontTile, t >= FN);
    // right-hand label: the latest step reached (the closing "fonts" word gets its own label)
    let k = -1; at.forEach((a, i) => { if (t >= a) k = i; });
    const fonts = t >= FN, lb = fonts ? ['Fonts', 'yours to pick', 'FONTS', '#f5eee4'] : k >= 0 ? c.steps[k].label : null, la = fonts ? FN : k >= 0 ? at[k] : 0;
    if (lb && c.lab.dataset.k !== lb[0] + lb[1]) { c.lab.dataset.k = lb[0] + lb[1]; c.labName.textContent = lb[0]; c.labMode.textContent = lb[1]; c.labSub.textContent = lb[2]; c.labSw.style.background = lb[3]; c.labSw.textContent = fonts ? 'Aa' : ''; }
    if (!lb && c.lab.dataset.k) { c.lab.dataset.k = ''; }
    if (lb && lb[0] !== 'Fonts') c.labSw.textContent = '';
    c.lab.style.opacity = lb ? (0.35 + 0.65 * ep(t, la, la + OUT(0.25))) * railO * ep(t, S0 + 0.4, S0 + 0.8) : 0;
    // wall of looks, popping one by one, then the tally badges
    c.wall.forEach((d, i) => { d.style.display = t > W0 + OUT(0.6) ? 'block' : 'none'; popIn(d, t, W0 + OUT(0.7 + i * 0.13), 0.5, { y: bob(t, i, 6) }); });
    c.badges.forEach((b, i) => popIn(b, t, W0 + OUT(1.9 + i * 0.12), 0.4));
  },
});

scene('open', {
  enter: 'rise',
  build(root, c) {
    css(root, { background: 'var(--paper)' });
    c.items = ['opensource', 'price', 'cross-platforms'].map((st, i) => {
      const box = el('div', 'abs col', root); place(box, 110 + i * 590, 230, 520); css(box, { alignItems: 'center', textAlign: 'center' });
      // same height for all three stickers, bottom-aligned in a fixed slot
      const slot = el('div', 'flex', box); css(slot, { height: '380px', width: '520px', alignItems: 'flex-end', justifyContent: 'center' });
      const im = el('img', '', slot); im.src = `../assets/stickers/sticker-${st}.png`; css(im, { height: '360px', width: 'auto', filter: 'drop-shadow(0 20px 30px #0003)', transformOrigin: '50% 100%' });
      const lab = el('div', 'display', box, ['Open source', 'Free', 'Cross-platform'][i]); css(lab, { fontSize: '76px', color: 'var(--paper-ink)', marginTop: '36px', whiteSpace: 'nowrap' });
      return { box, im, lab };
    });
  },
  update(t, c) {
    // stickers and their labels pop on "open source", "free" and "across all your devices"
    const CU = [cue(c, 'open source', 0, 2.3), cue(c, 'free', 0, 3.2), cue(c, 'across', 0, 4.06)];
    c.items.forEach(({ im, lab }, i) => { const a = CU[i] - 0.1; popIn(im, t, a, 0.5, { y: bob(t, i, 8) }); riseIn(lab, t, a + 0.1, 0.5, 30); });
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
    c.tag = el('div', 'abs', root, 'A little life. A lasting story.'); css(c.tag, { left: 0, right: 0, top: '630px', textAlign: 'center', fontSize: '42px', color: 'var(--cream-2)', letterSpacing: '0.02em' });
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
