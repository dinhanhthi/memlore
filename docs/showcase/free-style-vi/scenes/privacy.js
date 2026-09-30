// Privacy chapter: local-first laptop, encryption scramble, and the three locks.

scene('local', {
  enter: 'wipe',
  build(root, c) {
    c.bg = blobs(root, ['#45d6c833', '#f3a73b33', '#5cb8ff22'], 21);
    c.cap = title(root, c.title, { x: 120, y: 300, w: 720, size: 104, align: 'left' });
    // icon-only "no server / no account / no tracking" badges, crossed out
    c.chips = ['server', 'user-round', 'chart-column'].map((n, i) => {
      const ch = el('div', 'chip abs', root);
      ch.innerHTML = svgIcon(n, '#d6ccbf', 2);
      place(ch, 120 + i * 150, 640, 110, 110); css(ch, { justifyContent: 'center', padding: 0, borderRadius: '32px' });
      ch.querySelector('svg').style.width = '56px'; ch.querySelector('svg').style.height = '56px';
      const slash = el('div', 'abs', ch); css(slash, { left: '7px', top: '52px', width: '96px', height: '6px', borderRadius: '3px', background: '#ff7597', transform: 'rotate(-40deg)' });
      ch.slash = slash;
      return ch;
    });
    // shield dome
    c.dome = el('div', 'abs', root);
    css(c.dome, { left: '905px', top: '85px', width: '910px', height: '910px', borderRadius: '50%', border: '3px dashed #45d6c877', background: 'radial-gradient(circle, #45d6c814 30%, transparent 70%)' });
    // laptop
    c.lap = el('div', 'abs', root); place(c.lap, 990, 270, 740, 520);
    const screen = el('div', 'abs', c.lap);
    css(screen, { left: '40px', top: 0, width: '660px', height: '420px', borderRadius: '22px 22px 6px 6px', background: '#0b0908', border: '10px solid #2d2721', boxShadow: '0 30px 80px #000c' });
    const base = el('div', 'abs', c.lap);
    css(base, { left: 0, top: '418px', width: '740px', height: '26px', borderRadius: '4px 4px 20px 20px', background: 'linear-gradient(#4a4037, #2a241f)' });
    // mini app inside the screen
    const app = el('div', 'abs', screen); css(app, { inset: 0, padding: '26px 30px', background: 'var(--ink-2)' });
    c.wifi = el('div', 'abs flex', app); place(c.wifi, 430, 18); css(c.wifi, { gap: '8px', fontSize: '16px', color: 'var(--cream-3)' });
    c.title = el('div', 'display', app, T('local.entryTitle')); css(c.title, { fontSize: '44px', marginTop: '30px' });
    c.body = el('div', '', app); css(c.body, { fontSize: '26px', color: 'var(--cream-2)', marginTop: '14px', lineHeight: 1.5, width: '560px' });
    c.saved = el('div', 'pill abs', app, `${svgIcon('check', '#8fb34a', 3)}${T('local.saved')}`);
    css(c.saved, { left: '30px', bottom: '22px', background: '#8fb34a26', color: '#cfe59b' }); c.saved.querySelector('svg').style.width = '18px';
    c.db = el('div', 'abs', app); place(c.db, 520, 290, 70, 70); c.db.innerHTML = svgIcon('hard-drive', '#45d6c8', 1.6);
    // outside services trying to get in
    const r = rng(5);
    c.threats = ['server', 'cloud', 'server', 'cloud', 'server'].map((n, i) => {
      const a = -2.4 + i * 1.2 + (r() - 0.5) * 0.2;
      const e = el('div', 'abs', root); place(e, 0, 0, 84, 84);
      e.innerHTML = svgIcon(n, '#d6ccbf', 1.6);
      const slash = el('div', 'abs', e); css(slash, { left: '-6px', top: '38px', width: '96px', height: '6px', borderRadius: '3px', background: '#ff7597', transform: 'rotate(-40deg)', transformOrigin: 'center' });
      // ripple where it hits the dome
      const rip = el('div', 'abs', root); place(rip, 0, 0, 120, 120); css(rip, { borderRadius: '50%', border: '4px solid #45d6c8', boxShadow: '0 0 30px #45d6c8aa', opacity: 0 });
      return { e, slash, rip, a, d: 0.23 * i };
    });
    c.sk = sticker(root, 'offline', 1580, 740, 250);
  },
  update(t, c) {
    c.bg.update(t);
    const w = s => voAt(c) + s * (c.vo[0] ? c.vo[0].dur / 8.8 : 1 / 1.12); // raw word start (s) in the voice file -> scene time
    titleIn(c.cap, t, 0.15);
    // "No server. No account. No tracking." (raw 4.72 / 5.76 / 6.72)
    c.chips.forEach((ch, i) => { const a = w([4.72, 5.76, 6.72][i]); popIn(ch, t, a); tf(ch.slash, { sx: ep(t, a + 0.2, a + 0.45), r: -40 }); });
    const dp = ep(t, 0.3, 1.1, 'outBack');
    // threats charge the dome again and again: first run-up 1 s, then bounce back + charge every P s
    const P = 1.15, cx = 1360, cy = 540, HIT = 500;
    let lastHit = 99;
    const threatState = c.threats.map(({ a, d }) => {
      const u = t - (1.0 + d);
      let rad, since = 99;
      if (u < 1.0) rad = lerp(980, HIT, Ease.inCubic(clamp(u)));
      else {
        const k = Math.floor((u - 1.0) / P), q = (u - 1.0 - k * P) / P;
        since = (u - 1.0) - k * P;
        rad = q < 0.4 ? lerp(HIT, HIT + 150, Ease.outCubic(q / 0.4)) : lerp(HIT + 150, HIT, Ease.inCubic((q - 0.4) / 0.6));
      }
      if (t > voEnd(c, 0, 8.5)) since = 99;
      lastHit = Math.min(lastHit, since);
      return { u, rad, since, a };
    });
    const glow = Math.max(0, 1 - lastHit / 0.35);
    tf(c.dome, { s: lerp(0.6, 1, dp) * (1 + 0.012 * glow), o: dp, r: t * 6 });
    c.dome.style.borderColor = `rgba(69,214,200,${0.47 + 0.5 * glow})`;
    c.dome.style.boxShadow = `0 0 ${80 * glow}px #45d6c855, inset 0 0 ${120 * glow}px #45d6c833`;
    riseIn(c.lap, t, 0.2, 0.8, 80);
    const aOff = w(3.6); // "offline"
    const off = t > aOff;
    const wp = ep(t, aOff, aOff + 0.4, 'outBack');
    c.wifi.innerHTML = `<span style="width:22px;height:22px;display:inline-block">${svgIcon(off ? 'wifi-off' : 'wifi', off ? '#ff7597' : '#8fb34a', 2.4)}</span><span>${off ? T('local.wifiOff') : T('local.wifiOn')}</span>`;
    tf(c.wifi, { s: off ? lerp(1.5, 1, wp) : 1 });
    const text = T('local.entryBody');
    c.body.innerHTML = typed(text, t, 0.9, 30) + caretHtml(t, t < 4.5);
    popIn(c.saved, t, w(1.04)); // "lives right on your device"
    tf(c.db, { s: 1 + 0.08 * Math.sin(t * 5), o: 0.9 });
    c.threats.forEach(({ e, slash, rip }, i) => {
      const { u, rad, since, a } = threatState[i];
      const shake = since < 0.25 ? Math.sin(since * 80) * 10 * (1 - since / 0.25) : 0;
      tf(e, { x: cx + Math.cos(a) * rad - 42, y: cy + Math.sin(a) * rad - 42, r: shake, s: since < 0.12 ? 0.88 : 1, o: clamp(u * 2) });
      tf(slash, { sx: ep(u, 1.0, 1.3), s: 1, r: -40 });
      const rp = prog(since, 0, 0.5);
      tf(rip, { x: cx + Math.cos(a) * 455 - 60, y: cy + Math.sin(a) * 455 - 60, s: lerp(0.2, 1.4, Ease.outCubic(rp)), o: since < 0.5 ? 1 - rp : 0 });
    });
    popIn(c.sk, t, w(3.6), 0.5, { y: bob(t), r: -6 });
  },
});

scene('encrypt', {
  enter: 'iris', enterOpts: { x: 1360, y: 540 },
  build(root, c) {
    c.bg = blobs(root, ['#a58bff33', '#45d6c833'], 33, '#0f0d12');
    c.cap = title(root, c.title, { y: 130, size: 96 });
    c.card = el('div', 'panel abs', root); place(c.card, 360, 440, 1200, 330);
    css(c.card, { padding: '44px 56px' });
    c.lines = ['a', 'b', 'c'].map(k => T(`encrypt.lines.${k}`));
    c.lineEls = c.lines.map(() => { const l = el('div', 'mono', c.card); css(l, { fontSize: '36px', lineHeight: 1.7, whiteSpace: 'pre' }); return l; });
    c.scan = el('div', 'abs', root); css(c.scan, { top: '420px', height: '370px', width: '8px', borderRadius: '4px', background: 'linear-gradient(#45d6c8, #a58bff)', boxShadow: '0 0 40px 10px #45d6c888' });
    c.lock = el('div', 'abs', root); place(c.lock, 900, 310, 120, 120);
    css(c.lock, { borderRadius: '32px', background: 'var(--ink-3)', border: '1px solid var(--line-2)', padding: '24px', boxShadow: '0 20px 60px #000a' });
    // v2 badges
    c.pills = [[T('encrypt.pill.aes'), '#45d6c8', 'lock'], [T('encrypt.pill.argon'), '#a58bff', 'key-round'], [T('encrypt.pill.zk'), '#f3a73b', 'eye-off']].map(([txt, col, ic], i) => {
      const p = el('div', 'chip abs', root, `${svgIcon(ic, col, 2.2)}<span>${txt}</span>`);
      place(p, 520 + i * 330, 830);
      return p;
    });
    c.sk = sticker(root, 'privacy-2', 1560, 740, 250);
  },
  update(t, c) {
    c.bg.update(t);
    const aEnc = cueT(c, 'encrypt.cue.encrypted', 0, 2.3), aLock = cueT(c, 'encrypt.cue.endToEnd', 0, 2.9), aNot = cueT(c, 'encrypt.cue.notEvenWe', 0, 3.8);
    titleIn(c.cap, t, 0.1);
    riseIn(c.card, t, 0.1, 0.6, 60);
    const sx = lerp(330, 1600, ep(t, aEnc, aLock + 0.4, 'inOutCubic'));
    css(c.scan, { left: sx + 'px', opacity: win(t, aEnc - 0.1, aLock + 0.55, 0.15, 0.2) });
    const G = 'ABCDEF0123456789+/=%$#';
    c.lineEls.forEach((l, li) => {
      const s = c.lines[li];
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const cx = 416 + i * 21.7; // approx glyph x in the mono line
        if (cx < sx && s[i] !== ' ') {
          const k = (i * 7 + li * 13 + Math.floor(t * 18)) % G.length;
          out += `<span style="color:${(i + li) % 3 ? '#45d6c8' : '#a58bff'}">${G[k]}</span>`;
        } else out += s[i];
      }
      l.innerHTML = out;
    });
    const locked = t > aLock + 0.4;
    c.lock.innerHTML = svgIcon(locked ? 'lock' : 'lock-open', locked ? '#45d6c8' : '#d6ccbf', 2);
    const lp = ep(t, aLock + 0.4, aLock + 0.8, 'outBack');
    tf(c.lock, { s: locked ? lerp(1.4, 1, lp) * (1 + 0.04 * Math.sin(t * 3)) : ep(t, 0.3, 0.7, 'outBack') });
    c.lock.style.boxShadow = locked ? `0 0 ${60 * (1 - prog(t, aLock + 0.4, aLock + 1.4)) + 20 + 15 * Math.sin(t * 3)}px #45d6c877` : '0 20px 60px #000a';
    c.pills.forEach((p, i) => popIn(p, t, aLock + 0.5 + i * 0.18));
    popIn(c.sk, t, aNot, 0.5, { y: bob(t), r: 6 });
  },
});

scene('locks', {
  enter: 'slide',
  build(root, c) {
    c.bg = blobs(root, ['#a58bff2a', '#ff759722', '#f3a73b22'], 44);
    c.cap = title(root, c.title, { x: 110, y: 330, w: 620, size: 92, align: 'left' });
    // entries panel
    c.panel = el('div', 'panel abs', root); place(c.panel, 760, 80, 660, 920); css(c.panel, { overflow: 'hidden' });
    const head = el('div', 'abs', c.panel); place(head, 36, 30, 560);
    head.innerHTML = `<div class="kicker" style="font-size:16px;color:var(--cream-3)">${T('locks.allEntries')}</div>`;
    c.count = el('div', 'display', head); css(c.count, { fontSize: '40px', marginTop: '6px' });
    c.list = el('div', 'abs', c.panel); place(c.list, 0, 140, 660);
    const R = (title, meta, kind) => ({ title, meta, kind });
    const E = k => T(`locks.entry.${k}`), J = k => T(`locks.journal.${k}`);
    c.vault = [R(E('party'), J('vault'), 'vault'), R(E('resign'), J('vault'), 'vault'), R(E('startup'), J('vault'), 'vault')];
    c.base = [R(E('run'), `${J('daily')} · 07:12`, 'n'), R(E('therapy'), `${J('health')} · 18:30`, 'second'),
      R(E('sprint'), `${J('work')} · 10:05`, 'n'), R(E('dad'), `${J('daily')} · 22:41`, 'second'),
      R(E('lunch'), `${J('daily')} · 12:40`, 'n'), R(E('health'), `${J('health')} · 09:15`, 'second'),
      R(E('market'), `${J('daily')} · 11:02`, 'n'), R(E('book'), `${J('daily')} · 21:10`, 'n')];
    const tint = { vault: '#ff7597', second: '#a58bff', n: 'var(--cream-3)' };
    c.rows = [...c.vault, ...c.base].map(r => {
      const row = el('div', '', c.list); css(row, { height: '92px', overflow: 'hidden', position: 'relative', borderTop: '1px solid var(--line)' });
      const inner = el('div', 'abs', row); place(inner, 36, 16, 600);
      inner.innerHTML = `<div class="meta" style="font-size:17px;color:${tint[r.kind]};font-family:var(--mono)">${r.meta}</div><div class="t display" style="font-size:30px;margin-top:6px">${r.title}</div>`;
      let mask = null;
      if (r.kind === 'second') {
        mask = el('div', 'abs flex', row, `<span style="width:26px;height:26px;display:inline-block">${svgIcon('lock', '#a58bff', 2.2)}</span><span>${T('locks.lockedEntry')}</span>`);
        place(mask, 36, 44); css(mask, { gap: '12px', fontSize: '24px', color: '#c9b6ff', fontWeight: 600 });
      }
      if (r.kind === 'vault') { const b = el('div', 'abs', row, svgIcon('eye-off', '#ff7597', 2)); place(b, 590, 30, 30, 30); }
      return { row, inner, mask, r, t: inner.querySelector('.t'), m: inner.querySelector('.meta') };
    });
    // overlay app lock screen
    c.over = el('div', 'abs', c.panel); css(c.over, { inset: 0, background: '#15120ff2', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '22px' });
    c.over.innerHTML = `<img src="../assets/logo-straight.png" style="width:190px"><div class="display" style="font-size:48px">${T('locks.welcome')}</div><div class="lead" style="font-size:24px">${T('locks.welcomeSub')}</div>`;
    c.fp = el('div', '', c.over); css(c.fp, { width: '120px', height: '120px', borderRadius: '50%', border: '3px solid #f3a73b66', padding: '22px', marginTop: '20px', position: 'relative' });
    c.fpIcon = el('div', '', c.fp); css(c.fpIcon, { width: '100%', height: '100%' });
    // lock cards
    c.cards = [
      ['fingerprint-pattern', '#f3a73b'],
      ['lock', '#a58bff'],
      ['eye-off', '#ff7597'],
    ].map(([ic, col], i) => {
      const card = el('div', 'panel abs', root); place(card, 1460, 120 + i * 290, 380, 250);
      css(card, { padding: '30px', borderRadius: '26px' });
      card.innerHTML = `<span style="width:72px;height:72px;border-radius:22px;background:${col}22;padding:16px;display:inline-block">${svgIcon(ic, col, 2.2)}</span>`;
      const rowb = el('div', 'flex abs', card); place(rowb, 30, 150, 320); css(rowb, { justifyContent: 'space-between' });
      const field = el('div', 'mono', rowb); css(field, { fontSize: '26px', color: col, letterSpacing: '4px', width: '200px', height: '44px', padding: '6px 14px', borderRadius: '12px', background: '#0006', border: '1px solid var(--line)' });
      const tg = toggle(rowb, col);
      return { card, field, tg, col };
    });
  },
  update(t, c) {
    c.bg.update(t);
    titleIn(c.cap, t, 0.2);
    riseIn(c.panel, t, 0.1, 0.7, 80);
    // the voice walks the layers: app lock → second lock → invisible lock
    const aApp = cueT(c, 'locks.cue.appLock', 0, 2.8), aSec = cueT(c, 'locks.cue.secondLock', 0, 8.3), aVault = cueT(c, 'locks.cue.invisibleLock', 0, 14.3);
    const appOk = cueT(c, 'locks.cue.guardsEverything', 0, 5.8) + 0.2, appOff = cueT(c, 'locks.cue.wantMore', 0, 7);
    const secType = cueT(c, 'locks.cue.extraPassword', 0, 9.2), secOn = cueT(c, 'locks.cue.matterMost', 0, 10.9), secOff = cueT(c, 'locks.cue.andForWhat', 0, 11.8);
    const vType = cueT(c, 'locks.cue.typePassword', 0, 18.4), vOn = cueT(c, 'locks.cue.rightPassword', 0, 18.8) + 0.3;
    const appLocked = ep(t, aApp + 0.3, aApp + 0.8, 'outCubic') * (1 - ep(t, appOff, appOff + 0.5, 'inOutCubic'));
    const secOpen = ep(t, secOn, secOn + 0.45) * (1 - ep(t, secOff, secOff + 0.4));
    const vaultOpen = ep(t, vOn, vOn + 0.6, 'outCubic');
    const n = 36 + Math.round(3 * vaultOpen);
    c.count.textContent = T('locks.count', { n });
    c.rows.forEach(({ row, inner, mask, r, t: title, m }, i) => {
      if (r.kind === 'vault') {
        const p = ep(t, vOn + i * 0.15, vOn + 0.5 + i * 0.15, 'outCubic');
        row.style.height = 92 * p + 'px';
        row.style.background = `rgba(255,117,151,${0.10 * p})`;
        tf(inner, { x: (1 - p) * -60, o: p });
      } else if (r.kind === 'second') {
        title.style.filter = `blur(${lerp(9, 0, secOpen)}px)`;
        m.style.filter = `blur(${lerp(5, 0, secOpen)}px)`;
        title.style.opacity = lerp(0.5, 1, secOpen);
        mask.style.opacity = 1 - secOpen;
        row.style.background = `rgba(165,139,255,${0.12 * secOpen})`;
      }
    });
    css(c.over, { opacity: appLocked, filter: `blur(${(1 - appLocked) * 10}px)`, display: appLocked > 0.01 ? 'flex' : 'none' });
    const ok = t > appOk;
    c.fpIcon.innerHTML = svgIcon(ok ? 'check' : 'fingerprint-pattern', ok ? '#8fb34a' : '#f3a73b', 2);
    c.fp.style.borderColor = ok ? '#8fb34a' : `rgba(243,167,59,${0.4 + 0.4 * Math.sin(t * 10)})`;
    c.fp.style.boxShadow = ok ? '0 0 40px #8fb34a88' : `0 0 ${20 + 20 * Math.sin(t * 10)}px #f3a73b55`;
    // the card being talked about is lit; the other two turn grey, dim and a little smaller
    const specs = [
      { i: 0, a: aApp, b: aSec, on: appLocked, typedAt: null },
      { i: 1, a: aSec, b: aVault, on: secOpen, typedAt: secType },
      { i: 2, a: aVault, b: c.dur + 1, on: vaultOpen, typedAt: vType },
    ];
    specs.forEach(({ i, a, b, on, typedAt }) => {
      const k = c.cards[i];
      const active = win(t, a - 0.2, b, 0.3, 0.3);
      const grey = ep(t, aApp - 0.2, aApp + 0.1) * (1 - active); // eases in, so no card jumps
      k.card.style.borderColor = active > 0.05 ? k.col : 'var(--line)';
      const br = 0.5 + 0.5 * Math.sin(t * 4 + i); // breathing while a lock waits for its password
      k.card.style.boxShadow = `0 30px 80px #0008, 0 0 ${(50 + 30 * br) * active}px ${k.col}55`;
      k.card.style.filter = grey > 0.01 ? `grayscale(${grey}) brightness(${1 - 0.3 * grey})` : 'none';
      const rise = ep(t, 0.4 + i * 0.15, 1.0 + i * 0.15, 'outCubic'); // keeps the rise-in, since tf() replaces its transform
      tf(k.card, { s: (1 + (0.04 + 0.015 * br) * active) * (1 - 0.08 * grey), x: -20 * active, y: (1 - rise) * 60 + bob(t, i * 2, 5), o: rise * (1 - 0.45 * grey) });
      setToggle(k.tg, on);
      if (typedAt != null) {
        const dots = Math.min(8, Math.max(0, Math.floor((t - typedAt) * 12)));
        const shown = on > 0.5 || (t > typedAt && t < typedAt + 1.6) ? dots : 0;
        k.field.textContent = '•'.repeat(on > 0.5 ? 8 : shown);
      } else k.field.textContent = appLocked > 0.5 ? (ok ? T('locks.touchIdOk') : T('locks.touchIdWait')) : '';
      k.field.style.fontSize = typedAt == null ? '18px' : '26px';
    });
  },
});
