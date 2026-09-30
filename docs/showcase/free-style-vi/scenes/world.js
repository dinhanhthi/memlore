// World chapter: the places map, sync you control, and import/export.

const MAP_Y = 90;
const geo = (lat, lon) => [((lon + 180) / 360) * W, MAP_Y + ((90 - lat) / 180) * 960];
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

scene('map', {
  enter: 'zoom',
  build(root, c) {
    css(root, { background: 'radial-gradient(ellipse at 50% 45%, #1d2127 0%, #121315 70%)' });
    c.cam = el('div', 'abs', root); css(c.cam, { inset: 0, transformOrigin: '50% 50%' });
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, c.cam);
    css(svg, { position: 'absolute', left: 0, top: 0 });
    const defs = svgEl('defs', {}, svg);
    const pat = svgEl('pattern', { id: 'dots', width: 1.25, height: 1.25, patternUnits: 'userSpaceOnUse' }, defs);
    svgEl('circle', { cx: 0.62, cy: 0.62, r: 0.42, fill: '#8b8f96' }, pat);
    const g = svgEl('g', { transform: `translate(0 ${MAP_Y}) scale(${W / 360} ${960 / 180})` }, svg);
    for (let lon = -180; lon <= 180; lon += 30) svgEl('line', { x1: lon + 180, y1: 0, x2: lon + 180, y2: 180, stroke: '#ffffff0d', 'stroke-width': 0.15 }, g);
    for (let lat = -60; lat <= 90; lat += 30) svgEl('line', { x1: 0, y1: 90 - lat, x2: 360, y2: 90 - lat, stroke: '#ffffff0d', 'stroke-width': 0.15 }, g);
    c.land = svgEl('path', { d: window.LAND_D, fill: 'url(#dots)', stroke: '#8b8f9633', 'stroke-width': 0.12 }, g);
    c.arcs = svgEl('g', {}, svg);
    c.stops = [
      ['denver', 39.74, -104.99, 'denver'],
      ['brookings', 44.31, -96.8, 'brookings'],
      ['detroit', 42.33, -83.05, 'mural-012'],
      ['paris', 48.86, 2.35, 'beach-013'],
      ['bentre', 10.24, 106.38, 'bentre'],
    ].map(([id, lat, lon, photo], i) => {
      const name = T(`map.place.${id}.name`), note = T(`map.place.${id}.note`);
      const [x, y] = geo(lat, lon);
      const pin = el('div', 'abs', c.cam); place(pin, x - 26, y - 52, 52, 52); css(pin, { zIndex: 5 });
      pin.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 22s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12z" fill="#f3a73b" stroke="#2a1a05" stroke-width="1.2"/><circle cx="12" cy="10" r="2.6" fill="#2a1a05"/></svg>`;
      const pulse = el('div', 'abs', c.cam); place(pulse, x - 8, y - 8, 16, 16); css(pulse, { borderRadius: '50%', border: '2px solid #f3a73b' });
      const card = el('div', 'abs', c.cam);
      const up = true;
      css(card, { left: x - 130 + 'px', top: (up ? y - 330 : y + 20) + 'px', width: '260px', padding: '12px 12px 16px', background: '#f7f0e4', borderRadius: '14px', boxShadow: '0 26px 50px #000b', zIndex: 10 + i, transformOrigin: up ? '50% 100%' : '50% 0%' });
      card.innerHTML = `<img src="../assets/photos/${photo}.jpg" style="width:236px;height:170px;object-fit:cover;border-radius:8px;display:block"><div style="color:#2b241d;font-family:var(--display);font-size:26px;font-weight:600;margin-top:10px">${name}</div><div style="color:#6b5f52;font-size:17px">${note}</div>`;
      const thumb = el('div', 'abs', c.cam); place(thumb, x - 36, (up ? y - 118 : y + 12), 72, 72);
      css(thumb, { borderRadius: '50%', border: '4px solid #f7f0e4', backgroundImage: `url(../assets/photos/${photo}.jpg)`, backgroundSize: 'cover', backgroundPosition: 'center', boxShadow: '0 10px 24px #000a', zIndex: 4 });
      return { x, y, pin, pulse, card, thumb, up };
    });
    // arcs between consecutive stops
    c.paths = c.stops.slice(1).map((s, i) => {
      const a = c.stops[i];
      const mx = (a.x + s.x) / 2, my = (a.y + s.y) / 2 - Math.max(60, Math.hypot(s.x - a.x, s.y - a.y) * 0.28);
      const d = `M${a.x} ${a.y} Q${mx} ${my} ${s.x} ${s.y}`;
      const glow = svgEl('path', { d, fill: 'none', stroke: '#f3a73b44', 'stroke-width': 10, 'stroke-linecap': 'round' }, c.arcs);
      const p = svgEl('path', { d, fill: 'none', stroke: '#ffcf7a', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'stroke-dasharray': '10 9' }, c.arcs);
      const len = p.getTotalLength();
      const mask = svgEl('path', { d, fill: 'none', stroke: '#000', 'stroke-width': 0 }, c.arcs);
      const dot = svgEl('circle', { r: 9, fill: '#fff', stroke: '#f3a73b', 'stroke-width': 4 }, c.arcs);
      return { glow, p, len, mask, dot };
    });
    c.scrim = el('div', 'abs', root); css(c.scrim, { left: 0, right: 0, top: 0, height: '300px', background: 'linear-gradient(#121315f2 40%, transparent)' });
    c.cap = title(root, c.title, { y: 50, size: 76 });
  },
  update(t, c) {
    const S = c.stops, END = c.dur || 12;
    // each pin drops on its spoken word ("Ảnh", "video", "ghi âm", "ghim", "nơi") together with its photo card above it;
    // the card holds, then shrinks into its round thumb while the camera follows the route
    const PIN = [cueT(c, 'map.cue.photos', 0, 0.7), cueT(c, 'map.cue.videos', 0, 1.6), cueT(c, 'map.cue.voice', 0, 2.1), cueT(c, 'map.cue.pin', 0, 2.9), cueT(c, 'map.cue.place', 0, 5.2)];
    const CARD = PIN.map(p => p + 0.15), HOLD = 1.0, LAST_HOLD = Math.max(1.2, END - 2.6 - CARD[4]);
    const hold = i => (i === S.length - 1 ? LAST_HOLD : HOLD);
    titleIn(c.cap, t, 0.2);
    let cx = 960, cy = 540;
    for (let i = 0; i < S.length; i++) {
      const a = i === 0 ? { x: 960, y: 540 } : S[i - 1];
      const q = ep(t, PIN[i] - 0.35, PIN[i] + 0.3, 'inOutCubic');
      if (t >= PIN[i] - 0.35) { cx = lerp(a.x, S[i].x, q); cy = lerp(a.y, S[i].y, q) - 90; }
    }
    const zin = ep(t, PIN[0] - 0.6, PIN[0] + 0.2, 'inOutCubic') * (1 - ep(t, END - 1.6, END - 0.2, 'inOutCubic'));
    const sc = lerp(1, 1.4, zin);
    const fx = lerp(960, cx, zin), fy = lerp(540, cy, zin);
    c.cam.style.transformOrigin = '0 0';
    c.cam.style.transform = `translate(${960 - fx * sc}px, ${540 - fy * sc}px) scale(${sc})`;
    c.land.style.opacity = ep(t, 0, 0.8);
    S.forEach((s, i) => {
      const pp = ep(t, PIN[i], PIN[i] + 0.45, 'outBack');
      tf(s.pin, { y: (1 - pp) * -80, o: clamp(pp * 3) });
      const pl = prog(t, PIN[i] + 0.2, PIN[i] + 1.2);
      css(s.pulse, { opacity: pl > 0 && pl < 1 ? 1 - pl : 0 }); tf(s.pulse, { s: 1 + pl * 5 });
      // big card: pops, holds, then shrinks into the round thumb
      const cin = ep(t, CARD[i], CARD[i] + 0.45, 'outBack');
      const shrink = ep(t, CARD[i] + hold(i), CARD[i] + hold(i) + 0.35, 'inOutCubic');
      tf(s.card, { s: lerp(0.3, 1, cin) * lerp(1, 0.25, shrink), y: bob(t, i, 6) * (1 - shrink), o: clamp(cin * 2) * (1 - shrink), r: (i % 2 ? 3 : -3) * (1 - shrink) });
      s.card.style.display = cin > 0 && shrink < 1 ? 'block' : 'none';
      popIn(s.thumb, t, CARD[i] + hold(i) + 0.15, 0.4);
    });
    c.paths.forEach(({ glow, p, len, dot }, i) => {
      const q = ep(t, PIN[i] + 0.1, PIN[i + 1], 'inOutCubic');
      const vis = len * q;
      // reveal the dashed line up to vis by clipping with a second dash pattern
      p.setAttribute('stroke-dasharray', q >= 1 ? '10 9' : `${dashUpTo(vis)} ${len}`);
      glow.setAttribute('stroke-dasharray', `${Math.max(0.01, vis)} 1e5`);
      glow.setAttribute('opacity', q > 0 ? 1 : 0); p.setAttribute('opacity', q > 0 ? 1 : 0);
      const pt = p.getPointAtLength(vis);
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
      dot.setAttribute('opacity', q > 0 && q < 1 ? 1 : 0);
    });
  },
});
// dash pattern "10 9" repeated up to length L, then a big gap
function dashUpTo(L) {
  const parts = []; let acc = 0;
  while (acc + 19 <= L) { parts.push(10, 9); acc += 19; }
  const rest = L - acc; parts.push(Math.max(0.01, Math.min(10, rest)), 1e5);
  return parts.join(' ');
}

scene('sync', {
  enter: 'wipe',
  build(root, c) {
    c.bg = blobs(root, ['#5cb8ff2a', '#a58bff22', '#45d6c81a'], 88);
    c.cap = title(root, c.title, { y: 70, size: 84 });
    const CY = 480; // one horizontal axis for devices, service card and packets
    const dev = (x, name, ic, col) => {
      const d = el('div', 'panel abs col', root); place(d, x, CY - 110, 270, 220);
      css(d, { alignItems: 'center', justifyContent: 'center', gap: '14px', border: `2px solid ${col}`, boxShadow: `0 30px 80px #0008, 0 0 44px ${col}40` });
      d.innerHTML = `<span style="width:84px;height:84px;display:inline-block">${svgIcon(ic, col, 1.4)}</span><div style="font-size:24px;font-weight:600">${name}</div>`;
      return d;
    };
    c.devs = [dev(90, T('sync.device.mac'), 'laptop', 'var(--teal)'), dev(1560, T('sync.device.imac'), 'monitor', 'var(--violet)')];
    // ONE large round card holding the two services and a "+" for more to come (generic cloud icons, no logos)
    c.hub = el('div', 'panel abs flex', root); place(c.hub, 600, CY - 140, 720, 280);
    css(c.hub, { borderRadius: '140px', justifyContent: 'center', gap: '44px' });
    const slot = (inner, label, dashed) => {
      const s = el('div', 'col', c.hub); css(s, { alignItems: 'center', gap: '12px', width: '170px' });
      const t = el('div', 'flex', s, inner); css(t, { width: '96px', height: '96px', borderRadius: '28px', justifyContent: 'center', padding: '22px', ...(dashed ? { border: '3px dashed var(--line-2)', background: '#ffffff08' } : { background: 'var(--ink-3)', border: '1px solid var(--line-2)' }) });
      el('div', '', s, label).style.cssText = `font-size:24px;font-weight:600;white-space:nowrap;${dashed ? 'color:var(--cream-3)' : ''}`;
      return s;
    };
    c.svc = [slot(svgIcon('cloud', 'var(--sky)', 1.8), T('sync.svc.gdrive')), slot(svgIcon('cloud', 'var(--cream)', 1.8), T('sync.svc.icloud')), slot(svgIcon('plus', 'var(--cream-3)', 1.8), T('sync.svc.more'), true)];
    // packets flow laptop -> round card -> iMac
    const lane = (x1, x2, col) => ({ x1, x2, col });
    c.lanes = [lane(370, 590, '#45d6c8'), lane(1330, 1550, '#a58bff')];
    c.packets = Array.from({ length: 6 }, (_, i) => { const p = el('div', 'abs', root); place(p, 0, 0, 44, 44); const col = c.lanes[i % 2].col; css(p, { borderRadius: '12px', background: col, padding: '9px', boxShadow: `0 0 24px ${col}88` }); p.innerHTML = svgIcon('lock', '#15120f', 2.6); return { p, i }; });
    // device list with revoke
    c.list = el('div', 'panel abs', root); place(c.list, 560, 680, 800, 340); css(c.list, { padding: '26px 34px' });
    css(el('div', 'mono', c.list, T('sync.listTitle')), { fontSize: '22px', letterSpacing: '0.22em', color: 'var(--cream-3)' });
    c.rows = [['laptop', T('sync.device.mac'), T('sync.status.this')], ['monitor', T('sync.device.imac'), T('sync.status.imac')], ['laptop', T('sync.device.oldAir'), T('sync.status.old')]].map(([ic, n, s], i) => {
      const r = el('div', 'flex', c.list); css(r, { gap: '18px', height: '80px', borderTop: i ? '1px solid var(--line)' : 'none', marginTop: i ? 0 : '14px' });
      r.innerHTML = `<span style="width:36px;height:36px;display:inline-block">${svgIcon(ic, 'var(--cream-2)', 1.8)}</span><div style="flex:1"><div style="font-size:25px;font-weight:600">${n}</div><div class="st" style="font-size:18px;color:var(--cream-3)">${s}</div></div>`;
      if (i === 2) { r._btn = el('div', 'pill', r, T('sync.revoke')); css(r._btn, { background: '#ff759726', color: '#ff9db5', fontSize: '20px', padding: '10px 20px' }); }
      return r;
    });
  },
  update(t, c) {
    c.bg.update(t);
    titleIn(c.cap, t, 0.2);
    // devices on "Đồng bộ" / "của chính bạn", the device list on "lưu trữ", the round card on "Google" with its service tiles on "Google" /
    // "iCloud" and the "+" on "nhiều hơn", locked packets from "mã hóa", the old laptop revoked on "trước khi"
    const aSync = cueT(c, 'sync.cue.sync', 0, 0.7), aOwn = cueT(c, 'sync.cue.own', 0, 1.3), aCloud = cueT(c, 'sync.cue.cloud', 0, 1.7);
    const aGoogle = cueT(c, 'sync.cue.google', 0, 2.7), aICloud = cueT(c, 'sync.cue.icloud', 0, 3.4), aMore = cueT(c, 'sync.cue.more', 0, 4.4);
    c.devs.forEach((d, i) => riseIn(d, t, i ? aOwn : aSync, 0.6, 50));
    popIn(c.hub, t, aGoogle - 0.35, 0.6, { y: bob(t, 1, 6) });
    [aGoogle, aICloud, aMore].forEach((a, i) => popIn(c.svc[i], t, a - 0.05, 0.5, i === 2 ? { o: 0.85 * ep(t, a, a + 0.5) } : {}));
    const P0 = cueT(c, 'sync.cue.encrypted', 0, 6.4) - 0.1;
    c.packets.forEach(({ p, i }) => {
      const lane = c.lanes[i % 2];
      const k = Math.floor(i / 2);
      const ph = (t - P0 - k * 0.45 - (i % 2) * 0.5) / 1.3;
      const q = ph - Math.floor(ph);
      const on = t > P0 + k * 0.45 + (i % 2) * 0.5 && t < (c.dur || 10) - 0.6;
      css(p, { left: lerp(lane.x1, lane.x2, q) - 22 + 'px', top: 480 - 22 - Math.sin(q * Math.PI) * 30 + 'px', opacity: on ? Math.sin(q * Math.PI) : 0 });
    });
    riseIn(c.list, t, aCloud, 0.6, 60);
    // revoke the old laptop
    const R = cueT(c, 'sync.cue.before', 0, 7.7);
    const r = c.rows[2];
    const rp = ep(t, R, R + 0.6);
    r._btn.style.transform = `scale(${t > R - 0.2 && t < R + 0.1 ? 0.9 : 1})`;
    r._btn.textContent = t > R ? T('sync.revoked') : T('sync.revoke');
    r.style.opacity = lerp(1, 0.35, rp);
    r.querySelector('.st').textContent = t > R ? T('sync.status.revoked') : T('sync.status.old');
    r.style.textDecoration = 'none';
    c.rows.forEach((row, i) => riseIn(row, t, aCloud + 0.3 + i * 0.12, 0.4, 20, { o: i === 2 ? lerp(1, 0.35, rp) : 1 }));
  },
});

scene('import', {
  enter: 'slide',
  build(root, c) {
    c.bg = blobs(root, ['#8fb34a2a', '#f3a73b22'], 99);
    const CY = 540; // one vertical centre for the source tiles, the logo and the export tiles
    c.kick = el('div', 'abs kicker', root, T('import.kicker')); place(c.kick, 90, 84);
    c.cap = title(root, c.title, { x: 90, y: 124, w: 1500, size: 80, align: 'left' });
    // generic tile: a coloured rounded square with a neutral glyph, then a name (no third-party logos)
    const tile = (parent, ic, col) => { el('span', '', parent, svgIcon(ic, '#1a1410', 2)).style.cssText = `flex:none;width:68px;height:68px;border-radius:18px;padding:15px;background:${col};display:inline-block;box-shadow:0 0 24px ${col}55`; };
    const SH = 108, SG = 22, OH = 120, OG = 30;
    c.src = [[T('import.src.dayOne'), 'book-open', '#5cb8ff'], [T('import.src.journey'), 'map-pin', '#45d6c8'], [T('import.src.appleJournal'), 'pen-line', '#ff9db5'], [T('import.src.markdown'), 'file-text', '#c9b6ff']].map(([n, ic, col], i) => {
      const b = el('div', 'panel-2 abs flex', root); place(b, 110, CY - (4 * SH + 3 * SG) / 2 + i * (SH + SG), 400, SH); css(b, { padding: '20px 28px', gap: '22px' });
      tile(b, ic, col);
      el('div', '', b, n).style.cssText = 'font-size:30px;font-weight:700';
      return b;
    });
    c.book = el('img', 'abs', root); c.book.src = '../assets/logo.png'; place(c.book, 820, CY - 170, 340); css(c.book, { filter: 'drop-shadow(0 26px 40px #0009)' });
    c.out = [['file-json', T('import.out.json')], ['file-text', T('import.out.markdown')]].map(([ic, n], i) => {
      const b = el('div', 'panel-2 abs flex', root); place(b, 1370, CY - (2 * OH + OG) / 2 + i * (OH + OG), 440, OH); css(b, { padding: '20px 28px', gap: '22px' });
      tile(b, ic, i ? '#c9b6ff' : '#8fb34a');
      el('div', '', b, n).style.cssText = 'font-size:30px;font-weight:700';
      return b;
    });
    c.flow = Array.from({ length: 12 }, (_, i) => { const d = el('div', 'abs', root); place(d, 0, 0, 16, 16); css(d, { borderRadius: '50%', background: i % 2 ? 'var(--gold)' : 'var(--leaf)' }); return d; });
    c.geo = { CY, SH, SG, OH, OG };
  },
  update(t, c) {
    c.bg.update(t);
    const { CY, SH, SG, OH, OG } = c.geo;
    titleIn(c.cap, t, 0.2);
    riseIn(c.kick, t, 0.1, 0.5, 20);
    // Memlore on "Bạn", the sources on "Day One", "Journey", "Apple Journal" (Markdown just after),
    // journals flow in on "mang theo", the exports appear on "xuất" / "mọi thứ" and flow out
    popIn(c.book, t, cueT(c, 'import.cue.moving', 0, 0.7), 0.5, { y: bob(t) });
    const SA = [cueT(c, 'import.cue.dayOne', 0, 1.3), cueT(c, 'import.cue.journey', 0, 2.1), cueT(c, 'import.cue.appleJournal', 0, 2.9)];
    SA.push(SA[2] + 0.5);
    c.src.forEach((b, i) => riseIn(b, t, SA[i] - 0.1, 0.5, 40));
    const OA = [cueT(c, 'import.cue.export', 0, 5.8), cueT(c, 'import.cue.everything', 0, 6.3)];
    c.out.forEach((b, i) => riseIn(b, t, OA[i], 0.5, 40));
    const IN0 = cueT(c, 'import.cue.bring', 0, 4.1), OUT0 = OA[0] + 0.4;
    c.flow.forEach((d, i) => {
      const inbound = i < 8;
      const k = inbound ? i % 4 : i % 2;
      const a = inbound ? IN0 : OUT0;
      const ph = ((t - a - (i % 3) * 0.2) / 0.9);
      const q = ph - Math.floor(ph);
      const y1 = inbound ? CY - (4 * SH + 3 * SG) / 2 + k * (SH + SG) + SH / 2 : CY;
      const y2 = inbound ? CY : CY - (2 * OH + OG) / 2 + k * (OH + OG) + OH / 2;
      const [x1, x2] = inbound ? [510, 900] : [1080, 1370];
      css(d, { left: lerp(x1, x2, q) + 'px', top: lerp(y1, y2, q) + 'px', opacity: t > a ? Math.sin(q * Math.PI) : 0 });
    });
  },
});
