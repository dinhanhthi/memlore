// Looking back: Calendar, Tags, On This Day and Statistics, one scene each.

const JOURNALS = [['Daily Journal', '#f3a73b'], ['Work Notes', '#a58bff'], ['Health', '#45d6c8'], ['Travel', '#ff7597'], ['Reading', '#5cb8ff']];
// emotions are 3-state only: bad / neutral / good
const MOODS = [['Good', '#8fb34a'], ['Neutral', '#f3a73b'], ['Bad', '#ff7597']];
const MOOD_FACES = [['Good', 'smile', '#8fb34a'], ['Neutral', 'meh', '#f3a73b'], ['Bad', 'frown', '#ff7597']];

scene('calendar', {
  enter: 'wipe',
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b2a', '#a58bff22', '#45d6c81a'], 171);
    c.cap = title(root, c.title, { y: 40, size: 76 });
    c.panel = el('div', 'panel abs', root); place(c.panel, 150, 190, 1040, 830); css(c.panel, { padding: '36px 46px' });
    el('div', 'display', c.panel, 'September 2026').style.fontSize = '54px';
    const dow = el('div', '', c.panel); css(dow, { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginTop: '26px', fontFamily: 'var(--mono)', fontSize: '18px', color: 'var(--cream-3)', textAlign: 'center' });
    ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].forEach(d => el('div', '', dow, d));
    const grid = el('div', '', c.panel); css(grid, { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '12px', marginTop: '14px' });
    const r = rng(17);
    // Sep 1 2026 is a Tuesday: one leading blank
    el('div', '', grid);
    c.days = Array.from({ length: 30 }, (_, i) => {
      const cell = el('div', '', grid); css(cell, { height: '112px', borderRadius: '18px', background: 'var(--ink-3)', border: '1px solid var(--line)', padding: '12px 14px', position: 'relative' });
      const num = el('div', 'mono', cell, String(i + 1)); css(num, { fontSize: '22px', color: 'var(--cream-3)' });
      const dots = el('div', 'flex', cell); css(dots, { gap: '7px', flexWrap: 'wrap', marginTop: '14px' });
      const n = i === 11 || i === 22 ? 0 : 1 + Math.floor(r() * r() * 4);
      const ds = Array.from({ length: n }, () => { const col = JOURNALS[Math.floor(r() * JOURNALS.length)][1]; const d = el('span', '', dots); css(d, { width: '22px', height: '22px', borderRadius: '50%', background: col, boxShadow: `0 0 12px ${col}aa`, display: 'inline-block' }); return d; });
      // the day's mood (3 states), top-right of the cell
      const mood = n ? MOOD_FACES[r() < 0.62 ? 0 : r() < 0.7 ? 1 : 2] : null;
      const face = mood ? el('span', 'ico abs', cell, svgIcon(mood[1], mood[2], 2.2)) : null;
      if (face) css(face, { right: '10px', top: '10px', width: '30px', height: '30px' });
      return { cell, num, ds, face };
    });
    // legend: what the dots and faces mean
    c.legend = el('div', 'panel abs', root); place(c.legend, 1250, 190, 520); css(c.legend, { padding: '40px 44px' }); // height follows its rows
    const sec = (label) => { const h = el('div', 'kicker', c.legend, label); css(h, { fontSize: '18px', color: 'var(--cream-3)', marginTop: c.legend.children.length > 1 ? '44px' : 0 }); };
    sec('Dots · journals');
    c.legendRows = JOURNALS.map(([n, col]) => { const r2 = el('div', 'flex', c.legend, `<span style="width:24px;height:24px;border-radius:50%;background:${col};box-shadow:0 0 12px ${col}aa;flex:none"></span><span>${n}</span>`); css(r2, { gap: '18px', fontSize: '28px', marginTop: '20px' }); return r2; });
    sec('Faces · mood');
    c.legendRows.push(...MOOD_FACES.map(([n, ic, col]) => { const r2 = el('div', 'flex', c.legend, `<span class="ico" style="width:32px;height:32px">${svgIcon(ic, col, 2.2)}</span><span>${n}</span>`); css(r2, { gap: '16px', fontSize: '28px', marginTop: '20px' }); return r2; }));
    c.cursor = el('div', 'abs', c.panel); css(c.cursor, { borderRadius: '18px', border: '3px solid var(--gold-2)', boxShadow: '0 0 30px #f3a73b88', pointerEvents: 'none' });
  },
  update(t, c) {
    c.bg.update(t);
    const w = s => voAt(c) + s * (c.vo[0] ? c.vo[0].dur / 2.96 : 1 / 1.12); // raw word start -> scene time
    titleIn(c.cap, t, 0.2);
    riseIn(c.panel, t, 0.05, 0.7, 70);
    // the cursor walks the month from "lights up" (raw 0.72) to just before the end of the scene, dots pop in behind it
    const A = w(0.72), STEP = ((c.dur || 6) - 0.9 - A) / 30;
    let cur = -1;
    riseIn(c.legend, t, 0.15, 0.7, 70);
    c.legendRows.forEach((l, i) => riseIn(l, t, 0.5 + i * 0.12, 0.45, 20));
    c.days.forEach(({ cell, num, ds, face }, i) => {
      const a = A + i * STEP;
      const done = t >= a;
      if (done) cur = i;
      ds.forEach((d, k) => popIn(d, t, a + k * 0.05, 0.35));
      if (face) popIn(face, t, a + 0.1, 0.35);
      num.style.color = done ? 'var(--cream)' : 'var(--cream-3)';
      cell.style.background = done && ds.length ? '#f3a73b12' : 'var(--ink-3)';
    });
    const endAt = A + 30 * STEP;
    if (cur >= 0 && t < endAt + 0.3) {
      const cell = c.days[cur].cell;
      css(c.cursor, { display: 'block', left: cell.offsetLeft + 'px', top: cell.offsetTop + 'px', width: cell.offsetWidth + 'px', height: cell.offsetHeight + 'px', opacity: 1 - prog(t, endAt, endAt + 0.3) });
    } else c.cursor.style.display = 'none';
  },
});

scene('tags', {
  enter: 'slide',
  build(root, c) {
    c.bg = blobs(root, ['#a58bff2a', '#ff759722', '#45d6c81a'], 181);
    // the app's Tags view: header row, then one table row per tag
    c.side = el('div', 'panel abs', root); place(c.side, 110, 90, 620, 900); css(c.side, { padding: '28px 0', borderRadius: '28px', overflow: 'hidden' });
    const head = el('div', 'flex', c.side); css(head, { padding: '0 28px 22px', borderBottom: '1px solid var(--line-2)', fontFamily: 'var(--mono)', fontSize: '18px', letterSpacing: '0.14em', color: 'var(--cream-3)', gap: '12px' });
    c.tagCount = el('span', '', head); css(c.tagCount, { flex: 1 });
    c.entryCount = el('span', '', head);
    el('span', 'flex', head, svgIcon('plus', '#fff', 2.6)).style.cssText = 'width:48px;height:48px;border-radius:50%;padding:12px;margin-left:14px;background:linear-gradient(135deg, var(--violet), var(--rose));box-shadow:0 8px 24px #a58bff55;flex:none';
    c.list = el('div', 'col', c.side);
    const TAGS = [['travel', '#ff7597', 42], ['porto', '#f3a73b', 17], ['running', '#45d6c8', 58], ['family', '#ffcf7a', 36], ['work', '#a58bff', 64], ['food', '#8fb34a', 23], ['reading', '#5cb8ff', 29], ['gratitude', '#ff9db5', 81]];
    c.tags = TAGS.map(([n, col, cnt], i) => {
      const row = el('div', 'flex', c.list); css(row, { gap: '18px', padding: '0 28px', height: '86px', borderBottom: '1px solid var(--line)' });
      el('span', '', row).style.cssText = `width:32px;height:14px;border-radius:999px;background:${col};flex:none`;
      el('span', '', row, n).style.cssText = 'flex:1;font-size:28px;font-weight:600;color:var(--cream)';
      const b = el('span', '', row); css(b, { fontSize: '26px', color: 'var(--cream-3)', minWidth: '50px', textAlign: 'right' });
      el('span', 'ico', row, svgIcon('pen-line', 'var(--cream-3)', 2)).style.cssText = 'width:26px;height:26px;margin-left:18px';
      return { row, b, col, cnt, n, a: 0.8 + i * 0.48 };
    });
    c.cap = title(root, c.title, { x: 820, y: 200, w: 1000, size: 92, align: 'left' });
    // entry card collecting tag chips (the app's Pill: mono, rounded, colour dot, no "#")
    c.card = el('div', 'panel abs', root); place(c.card, 820, 600, 1000, 330); css(c.card, { padding: '34px 40px' });
    c.card.innerHTML = '<div class="mono" style="font-size:18px;color:var(--cream-3)">DAILY JOURNAL · SAT, SEP 19</div><div class="display" style="font-size:44px;margin-top:8px">Saturday in Porto</div>';
    c.chips = el('div', 'flex', c.card); css(c.chips, { gap: '12px', flexWrap: 'wrap', marginTop: '26px' });
    c.chipEls = c.tags.map(({ col, n }) => {
      const ch = el('span', 'flex mono', c.chips, `<span style="width:12px;height:12px;border-radius:50%;background:${col};flex:none"></span>${n}`);
      css(ch, { gap: '10px', fontSize: '22px', padding: '8px 18px', borderRadius: '999px', border: '1px solid var(--line-2)', background: 'var(--ink-3)', color: 'var(--cream)' });
      return ch;
    });
    c.onCard = [0, 1, 5, 7];
  },
  update(t, c) {
    c.bg.update(t);
    riseIn(c.side, t, 0.05, 0.7, 60);
    titleIn(c.cap, t, 0.2);
    riseIn(c.card, t, 0.5, 0.6, 50);
    let shown = 0, entries = 0;
    c.tags.forEach(({ row, b, cnt, a }) => {
      const p = ep(t, a, a + 0.45, 'outBack');
      row.style.display = t >= a ? 'flex' : 'none';
      tf(row, { x: (1 - p) * -80, o: clamp(p * 1.5) });
      // the newest row is selected (the app's elevated row background)
      const fresh = win(t, a, a + 1.0, 0.1, 0.5);
      row.style.background = `rgba(255,255,255,${0.07 * fresh})`;
      const n = countUp(t, a + 0.15, a + 1.1, cnt);
      b.textContent = n;
      if (t >= a) { shown++; entries += n; }
    });
    c.tagCount.textContent = `TAGS\u2003${shown}`;
    c.entryCount.textContent = `ENTRIES\u2003${entries}`;
    const aWay = cue(c, 'your way', 0, 3.2);
    c.chipEls.forEach((ch, i) => {
      const on = c.onCard.includes(i);
      // chips land on "your way", one after another, but never before their tag row
      const at = Math.max(c.tags[i].a + 0.2, aWay + c.onCard.indexOf(i) * 0.3);
      ch.style.display = on && t >= at ? 'inline-flex' : 'none';
      popIn(ch, t, at, 0.4);
    });
  },
});

scene('onThisDay', {
  enter: 'iris', enterOpts: { x: 960, y: 540 },
  build(root, c) {
    c.bg = blobs(root, ['#ffcf7a2a', '#a58bff2a', '#ff759722'], 191, '#14110f');
    // clock rewinding
    c.clock = el('div', 'abs', root); place(c.clock, 130, 110, 250, 250);
    css(c.clock, { borderRadius: '50%', border: '6px solid var(--gold)', background: 'radial-gradient(circle, #f3a73b18, transparent 70%)', boxShadow: '0 0 60px #f3a73b44' });
    for (let k = 0; k < 12; k++) { const m = el('div', 'abs', c.clock); css(m, { left: '119px', top: '10px', width: '6px', height: k % 3 ? '12px' : '22px', borderRadius: '3px', background: 'var(--cream-3)', transformOrigin: '3px 113px', transform: `rotate(${k * 30}deg)` }); }
    const hand = (len, w, col) => { const h = el('div', 'abs', c.clock); css(h, { left: 122 - w / 2 + 'px', top: 122 - len + 'px', width: w + 'px', height: len + 'px', borderRadius: w + 'px', background: col, transformOrigin: `50% ${len}px` }); return h; };
    c.hour = hand(62, 10, 'var(--cream)'); c.min = hand(92, 6, 'var(--gold-2)');
    c.cap = title(root, c.title, { x: 440, y: 160, w: 1300, size: 90, align: 'left' });
    c.date = el('div', 'abs mono', root); place(c.date, 444, 310); css(c.date, { fontSize: '30px', color: 'var(--cream-2)' });
    // timeline
    c.line = el('div', 'abs', root); place(c.line, 260, 900, 1400, 6); css(c.line, { borderRadius: '3px', background: 'linear-gradient(90deg, #f3a73b22, #f3a73b)' });
    c.years = [2022, 2023, 2024, 2025, 2026];
    c.ticks = c.years.map((y, i) => {
      const x = 260 + i * 350;
      const d = el('div', 'abs', root); place(d, x - 14, 889, 28, 28); css(d, { borderRadius: '50%', background: 'var(--ink-3)', border: '4px solid var(--gold)' });
      const l = el('div', 'abs display', root, String(y)); place(l, x - 80, 930, 160); css(l, { textAlign: 'center', fontSize: '38px', color: 'var(--cream-3)' });
      return { d, l, x };
    });
    c.head = el('div', 'abs', root); place(c.head, 0, 878, 50, 50); css(c.head, { borderRadius: '50%', background: 'var(--gold-2)', boxShadow: '0 0 40px 10px #f3a73b99', zIndex: 5 });
    c.cards = [
      ['4 years ago', 'First day at the new flat', 'Boxes everywhere. Pizza on the floor.', 'cafe-006'],
      ['3 years ago', 'Hiking the Sintra trail', 'Fog, then the whole coast at once.', 'sintra-002'],
      ['2 years ago', 'Rainy Sunday', 'Tea, a novel and nowhere to be.', 'rain-008'],
      ['1 year ago', 'Dinner with the family', 'Mum made her fish soup again.', 'dinner-017'],
    ].map(([ago, h, b, ph], i) => {
      const card = el('div', 'abs', root); place(card, 260 + i * 350 - 165, 430, 330, 420);
      css(card, { padding: '14px 14px 18px', background: '#f7f0e4', borderRadius: '16px', boxShadow: '0 30px 60px #000b', transformOrigin: '50% 100%' });
      card.innerHTML = `<img src="../assets/photos/${ph}.jpg" style="width:302px;height:220px;object-fit:cover;border-radius:10px;display:block"><div class="mono" style="font-size:16px;color:#b8743a;margin-top:12px;letter-spacing:.1em">${ago.toUpperCase()}</div><div style="color:#2b241d;font-family:var(--display);font-size:28px;font-weight:600;margin-top:4px;line-height:1.1">${h}</div><div style="color:#6b5f52;font-size:18px;margin-top:6px">${b}</div>`;
      return card;
    });
  },
  update(t, c) {
    c.bg.update(t);
    popIn(c.clock, t, 0.1, 0.5);
    titleIn(c.cap, t, 0.25);
    const w = s => voAt(c) + s * (c.vo[0] ? c.vo[0].dur / 5.44 : 1 / 1.12); // raw word start -> scene time
    // playhead rewinds 2026 → 2025 on "a year ago" (raw 2.64), then on to 2022 over "and the years before that" (3.84+);
    // u = years rewound (0..4); the clock spins backwards with it
    const p1 = ep(t, w(1.04), w(2.64) + 0.1, 'inOutCubic'), p2 = ep(t, w(3.84) - 0.1, w(5.0) + 1.2, 'inOutCubic');
    const u = p1 + p2 * 3, q = u / 4;
    const hx = lerp(c.ticks[4].x, c.ticks[0].x, q);
    tf(c.head, { x: hx - 25, s: 1 + 0.15 * Math.sin(t * 8) * ((p1 > 0 && p1 < 1) || (p2 > 0 && p2 < 1) ? 1 : 0) });
    const spin = -q * 4 * 360;
    c.min.style.transform = `rotate(${spin * 12 + 60}deg)`; c.hour.style.transform = `rotate(${spin + 300}deg)`;
    c.line.style.opacity = ep(t, 0.4, 0.9);
    const year = Math.round(2026 - u);
    c.date.innerHTML = `September 30, <span style="color:var(--gold-2)">${year}</span>`;
    riseIn(c.date, t, 0.5, 0.4, 20);
    c.ticks.forEach(({ d, l, x }, i) => {
      const passed = hx <= x + 1;
      d.style.background = passed ? 'var(--gold)' : 'var(--ink-3)';
      l.style.color = passed ? 'var(--cream)' : 'var(--cream-3)';
      riseIn(l, t, 0.5 + i * 0.06, 0.4, 20);
      popIn(d, t, 0.5 + i * 0.06, 0.4);
    });
    // each card rises from its year as the playhead reaches it (right to left)
    c.cards.forEach((card, i) => {
      const p = Ease.outBack(prog(u, 3.75 - i, 4 - i));
      card.style.display = p > 0 ? 'block' : 'none';
      tf(card, { y: (1 - p) * 220 + (p >= 1 ? bob(t, i, 5) : 0), s: lerp(0.3, 1, p), r: (i % 2 ? 3 : -3) * p, o: clamp(p * 2) });
    });
  },
});

scene('stats', {
  enter: 'rise',
  build(root, c) {
    c.bg = blobs(root, ['#45d6c82a', '#f3a73b22', '#a58bff22'], 201);
    c.cap = title(root, c.title, { y: 70, size: 80 });
    const G = { x: 110, y: 250, w: 540, h: 340, gx: 30, gy: 30 };
    const card = (i, ic, col) => {
      const d = el('div', 'panel abs', root); place(d, G.x + (i % 3) * (G.w + G.gx), G.y + Math.floor(i / 3) * (G.h + G.gy), G.w, G.h);
      css(d, { padding: '30px 34px', borderRadius: '28px', overflow: 'hidden' });
      el('span', '', d, svgIcon(ic, col, 2.2)).style.cssText = `width:56px;height:56px;border-radius:16px;padding:12px;background:${col}26;display:inline-block`;
      return d;
    };
    const big = (d, col) => { const n = el('div', 'display', d); css(n, { fontSize: '84px', color: col, marginTop: '14px', lineHeight: 1 }); return n; };
    c.cards = [];
    // 1. entries + sparkline
    let d = card(0, 'book-open', '#f3a73b'); c.entries = big(d, 'var(--gold-2)');
    const sp = svgEl('svg', { width: 472, height: 120, viewBox: '0 0 472 120' }, d); css(sp, { position: 'absolute', left: '34px', bottom: '24px' });
    const pts = [30, 42, 38, 55, 50, 68, 62, 80, 74, 92, 88, 104].map((v, k) => `${k * 42},${120 - v}`).join(' ');
    c.spark = svgEl('polyline', { points: pts, fill: 'none', stroke: '#f3a73b', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sp);
    c.sparkLen = 520;
    c.cards.push(d);
    // 2. words by month
    d = card(1, 'feather', '#a58bff'); c.words = big(d, '#c9b6ff');
    c.bars = [40, 55, 48, 70, 62, 85, 78, 95, 72, 88, 100, 92].map((v, k) => { const b = el('div', 'abs', d); css(b, { left: 34 + k * 40 + 'px', bottom: '28px', width: '28px', height: '0px', borderRadius: '8px 8px 3px 3px', background: 'linear-gradient(#c9b6ff, #a58bff66)' }); b._h = v * 1.1; return b; });
    c.cards.push(d);
    // 3. streak ring
    d = card(2, 'calendar-days', '#45d6c8');
    const ring = svgEl('svg', { width: 200, height: 200, viewBox: '0 0 200 200' }, d); css(ring, { position: 'absolute', right: '40px', top: '90px' });
    svgEl('circle', { cx: 100, cy: 100, r: 80, fill: 'none', stroke: '#45d6c822', 'stroke-width': 20 }, ring);
    c.ringArc = svgEl('circle', { cx: 100, cy: 100, r: 80, fill: 'none', stroke: '#45d6c8', 'stroke-width': 20, 'stroke-linecap': 'round', transform: 'rotate(-90 100 100)', 'stroke-dasharray': '0 503' }, ring);
    c.streak = big(d, '#8ff0e6'); css(c.streak, { marginTop: '60px' });
    c.cards.push(d);
    // 4. mood split (3 states)
    d = card(3, 'smile', '#8fb34a');
    c.moodBars = [['Good', '#8fb34a', 64], ['Neutral', '#f3a73b', 25], ['Bad', '#ff7597', 11]].map(([n, col, v], k) => {
      const row = el('div', 'abs', d); place(row, 34, 110 + k * 70, 472);
      row.innerHTML = `<div class="flex" style="justify-content:space-between;font-size:22px"><span>${n}</span><span class="v mono" style="color:${col}"></span></div>`;
      const tr = el('div', '', row); css(tr, { height: '14px', borderRadius: '7px', background: 'var(--ink-4)', marginTop: '8px', overflow: 'hidden' });
      const f = el('div', '', tr); css(f, { height: '100%', width: '0%', background: col, borderRadius: '7px', boxShadow: `0 0 16px ${col}` });
      return { f, v, lab: row.querySelector('.v') };
    });
    c.cards.push(d);
    // 5. heatmap
    d = card(4, 'chart-column', '#ff7597');
    const hm = el('div', 'abs', d); css(hm, { left: '34px', top: '100px', display: 'grid', gridTemplateColumns: 'repeat(18, 22px)', gap: '5px' });
    const r = rng(23);
    c.cells = Array.from({ length: 18 * 7 }, () => { const x = el('div', '', hm); const v = r(); css(x, { width: '22px', height: '22px', borderRadius: '5px', background: v < 0.2 ? 'var(--ink-4)' : `rgba(255,117,151,${0.25 + v * 0.75})` }); return x; });
    c.cards.push(d);
    // 6. time of day
    d = card(5, 'history', '#5cb8ff'); c.hourN = big(d, '#9ed3ff');
    c.hours = [2, 1, 1, 1, 1, 2, 5, 9, 7, 4, 3, 3, 4, 3, 3, 4, 5, 6, 8, 12, 16, 20, 14, 6].map((v, k) => { const b = el('div', 'abs', d); css(b, { left: 34 + k * 19.6 + 'px', bottom: '28px', width: '14px', height: '0px', borderRadius: '4px', background: k === 21 ? '#5cb8ff' : '#5cb8ff55' }); b._h = v * 5.5; return b; });
    c.cards.push(d);
  },
  update(t, c) {
    c.bg.update(t);
    titleIn(c.cap, t, 0.1);
    const A = i => 1.0 + i * 0.42; // card i appears, from "habits?" (raw 0.76) on; the last lands with "numbers!" (raw 3.04)
    c.cards.forEach((d, i) => popIn(d, t, A(i), 0.5));
    const run = (i, d = 1.8) => ep(t, A(i) + 0.3, A(i) + 0.3 + d, 'outCubic');
    c.entries.textContent = Math.round(1248 * run(0)).toLocaleString('en-US');
    c.spark.setAttribute('stroke-dasharray', `${c.sparkLen * run(0)} ${c.sparkLen}`);
    c.words.textContent = Math.round(312480 * run(1)).toLocaleString('en-US');
    c.bars.forEach((b, k) => { b.style.height = b._h * ep(t, A(1) + 0.3 + k * 0.06, A(1) + 0.8 + k * 0.06, 'outBack') + 'px'; });
    c.streak.textContent = Math.round(42 * run(2));
    c.ringArc.setAttribute('stroke-dasharray', `${503 * 0.84 * run(2)} 503`);
    c.moodBars.forEach(({ f, v, lab }, k) => { const p = ep(t, A(3) + 0.3 + k * 0.15, A(3) + 1.3 + k * 0.15); f.style.width = v * p + '%'; lab.textContent = Math.round(v * p) + '%'; });
    c.cells.forEach((x, k) => { const col = Math.floor(k / 7); popIn(x, t, A(4) + 0.3 + col * 0.05 + (k % 7) * 0.01, 0.3); });
    c.hours.forEach((b, k) => { b.style.height = b._h * ep(t, A(5) + 0.3 + k * 0.03, A(5) + 0.8 + k * 0.03, 'outBack') + 'px'; });
    c.hourN.textContent = t > A(5) + 1.0 ? '9 PM' : '';
    popIn(c.hourN, t, A(5) + 1.0, 0.4);
  },
});
