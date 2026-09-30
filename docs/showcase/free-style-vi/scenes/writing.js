// Writing chapter: a live-typing editor tour, then search + the ways to look back.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Build a typing schedule: pieces are strings (typed as-is) or { raw, html } (markdown that
// converts once fully typed). Returns { at(t) -> html, end }.
function typer(pieces, start, cps = 48) {
  let cur = start;
  const sched = pieces.map(p => {
    const piece = typeof p === 'string' ? { raw: p, html: esc(p) } : p;
    const a = cur; const d = piece.raw.length / (piece.cps || cps);
    cur += d + (piece.pause || 0);
    return { ...piece, a, e: a + d };
  });
  return {
    a: start,
    end: cur,
    sched,
    at(t) {
      let out = '';
      for (const s of sched) {
        if (t < s.a) break;
        if (t >= s.e) { out += s.html; continue; }
        const n = Math.floor((t - s.a) * (s.raw.length / (s.e - s.a)));
        const part = s.raw.slice(0, n);
        out += s.raw === s.html || !s.mk ? esc(part) : `<span class="mk">${esc(part)}</span>`;
      }
      return out;
    },
  };
}
const MK = (raw, html) => ({ raw, html, mk: true });

scene('editor', {
  enter: 'rise',
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b33', '#ff759722', '#a58bff22'], 55);
    c.cap = title(root, c.title, { y: 26, size: 76 });
    const { win, body } = macWindow(root, 210, 150, 1500, 900, T('editor.windowTitle'));
    c.win = win;
    c.docWrap = el('div', 'abs', body); css(c.docWrap, { left: 0, right: 0, top: 0, bottom: '64px', overflow: 'hidden' });
    c.doc = el('div', 'doc abs', c.docWrap); css(c.doc, { left: '70px', right: '70px', top: '30px' });
    const foot = el('div', 'abs flex', body); css(foot, { left: 0, right: 0, bottom: 0, height: '64px', borderTop: '1px solid var(--line)', padding: '0 30px', justifyContent: 'space-between', fontSize: '20px', color: 'var(--cream-3)', fontFamily: 'var(--mono)' });
    c.wc = el('span', '', foot); c.saved = el('span', '', foot);

    // ── schedule ── each markdown shortcut and block lands on its spoken word (lib.js cue())
    const q = (key, fb) => cueT(c, `editor.cue.${key}`, 0, fb);
    c.w0 = voAt(c);
    const TM = {};
    const SM = 0.6; // slash menu on screen
    TM.h1 = typer([MK('# ', ''), { raw: T('editor.h1'), html: T('editor.h1') }], q('headings', 2.3) - 0.3, 30);
    // the paragraph is typed at 70 cps, slowed down (to at most 30 cps) so it fills the time up to "danh sách việc cần làm"
    // instead of finishing early and leaving the window still while the voice lists "làm nổi bật, liên kết"
    const pPieces = [T('editor.p.a'), { ...MK(`[${T('editor.p.link')}](https://…)`, `<a>${T('editor.p.link')}</a>`), pause: 0.3 }, T('editor.p.b'), MK(`==${T('editor.p.mark')}==`, `<mark>${T('editor.p.mark')}</mark>`), T('editor.p.c')];
    const pA = TM.h1.end + 0.05, pFit = Math.max(q('checklists', 4.2) - 0.1 - 0.4 - pA, 0.1);
    TM.p = typer(pPieces, pA, clamp(70 * (typer(pPieces, pA, 70).end - pA) / pFit, 30, 70));
    TM.slash1 = Math.max(TM.p.end + 0.35, q('checklists', 4.2) - 0.1); // "/" → checklist, once the paragraph is typed
    TM.todo1 = typer([T('editor.todo')], TM.slash1 + 0.4, 40);
    TM.check1 = TM.todo1.end + 0.15;
    TM.slash2 = Math.max(TM.check1 + 0.35, q('code', 4.9) - 0.1); // code, once the checklist item is done
    const code = [[['tk-k', 'const '], ['tk-p', 'km = days.'], ['tk-f', 'map'], ['tk-p', '(d => d.walked)']]];
    TM.codeA = TM.slash2 + 0.5; TM.codeLen = code.flat().reduce((n, [, s]) => n + s.length, 0); TM.codeE = TM.codeA + TM.codeLen / 58;
    TM.slash3 = Math.max(TM.codeE + 0.35, q('math', 5.9) - 0.1); // math
    const tex = '\\sum_{d=1}^{3} \\text{km}_d = 42.2';
    TM.mathA = TM.slash3 + 0.5; TM.mathE = TM.mathA + ('$$' + tex + '$$').length / 80;
    TM.imgDrop = q('photos', 8.4); // photos: drag in from the top, drop on "photos"
    TM.img = TM.imgDrop - 1.1;
    TM.aud = q('audio', 9.2); TM.vid = q('video', 10.1); // then audio and video join the same row
    TM.slashType = 0.3; // the "/" is typed this long before its menu opens
    c.TM = TM; c.code = code; c.tex = tex; c.SM = SM;
    c.texHtml = katex.renderToString(tex, { displayMode: true, throwOnError: false });

    // blocks
    // an empty line where "/" is typed, just before each block it opens
    // each "/" line takes the top margin of the block that replaces it (pre / .math: 12 px), so the
    // collapsed margins match and the block lands exactly where the "/" was
    const slashLine = (mt = 0) => { const l = el('p', '', c.doc); css(l, { display: 'none', marginTop: mt + 'px' }); return l; };
    c.h1 = el('div', '', c.doc); c.p = el('p', '', c.doc);
    c.slashLines = [slashLine()];
    c.todos = [0].map(() => { const d = el('div', 'todo', c.doc); d._box = el('div', 'box', d); d._txt = el('span', '', d); return d; });
    c.slashLines.push(slashLine(12));
    c.pre = el('pre', '', c.doc);
    c.slashLines.push(slashLine(12));
    c.math = el('div', 'math', c.doc);
    // photo, audio and video share one row; each new block pushes the earlier ones left
    c.row = el('div', 'flex', c.doc); css(c.row, { gap: '20px', marginTop: '10px', alignItems: 'stretch', overflow: 'hidden' });
    c.imgBox = el('div', '', c.row); css(c.imgBox, { borderRadius: '18px', overflow: 'hidden', position: 'relative', flex: 'none', height: '100%' });
    const im = el('img', '', c.imgBox); im.src = '../assets/photos/porto-003.jpg'; css(im, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
    const capn = el('div', 'abs', c.imgBox, T('editor.photoCaption')); css(capn, { left: '18px', bottom: '14px', fontSize: '20px', padding: '6px 14px', borderRadius: '10px', background: '#0009' });
    c.aud = el('div', 'panel-2 flex', c.row); css(c.aud, { flex: 'none', gap: '18px', padding: '0 22px', overflow: 'hidden' });
    const mic = el('span', 'ico', c.aud, svgIcon('mic', 'var(--gold-2)', 2)); css(mic, { width: '56px', height: '56px', padding: '14px', borderRadius: '50%', background: '#f3a73b30', flex: 'none' });
    c.wave = el('div', 'flex', c.aud); css(c.wave, { flex: 1, gap: '5px', height: '64px' });
    c.bars = Array.from({ length: 28 }, (_, i) => { const b = el('span', '', c.wave); css(b, { flex: 1, height: 12 + 52 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)) + 'px', borderRadius: '3px' }); return b; });
    el('span', 'mono', c.aud, '0:24').style.cssText = 'font-size:20px;color:var(--cream-3)';
    c.vid = el('div', 'panel-2', c.row); css(c.vid, { flex: 'none', position: 'relative', overflow: 'hidden' });
    const vim = el('img', '', c.vid); vim.src = '../assets/photos/lisbon-001.jpg'; css(vim, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
    const shade = el('div', 'abs', c.vid); css(shade, { inset: 0, background: '#0006' });
    const pb = el('div', 'abs flex', c.vid); css(pb, { left: 'calc(50% - 32px)', top: 'calc(50% - 32px)', width: '64px', height: '64px', borderRadius: '50%', background: '#fffe', justifyContent: 'center' });
    el('span', '', pb).style.cssText = 'width:20px;height:22px;margin-left:5px;background:#15120f;clip-path:polygon(0 0,100% 50%,0 100%)';
    const vt = el('div', 'abs mono', c.vid, '0:12'); css(vt, { right: '10px', bottom: '14px', fontSize: '16px', padding: '2px 8px', borderRadius: '8px', background: '#0009' });
    c.vprog = el('div', 'abs', c.vid); css(c.vprog, { left: 0, bottom: 0, height: '5px', background: 'var(--gold-2)' });
    // slash menu
    c.menu = el('div', 'panel abs', c.docWrap); css(c.menu, { width: '360px', padding: '12px', borderRadius: '18px', background: 'var(--ink-3)', zIndex: 5 });
    c.menuItems = [['heading', 'heading'], ['list-checks', 'checklist'], ['code', 'code'], ['sigma', 'math'], ['image', 'image'], ['table', 'table']].map(([ic, key]) => {
      const l = T(`editor.menu.${key}`);
      const it = el('div', 'flex', c.menu); css(it, { gap: '14px', padding: '10px 14px', borderRadius: '12px', fontSize: '22px' });
      it.innerHTML = `<span class="ico" style="width:26px;height:26px">${svgIcon(ic, 'currentColor', 2)}</span>${l}`;
      return it;
    });
    // dragged photo
    c.drag = el('div', 'abs', root); css(c.drag, { width: '260px', height: '170px', borderRadius: '16px', overflow: 'hidden', boxShadow: '0 30px 60px #000c', border: '3px solid #fff', zIndex: 30 });
    el('img', '', c.drag).src = '../assets/photos/porto-003.jpg'; css(c.drag.firstChild, { width: '100%', height: '100%', objectFit: 'cover' });
    c.cursor = el('div', 'abs', root); css(c.cursor, { width: '34px', height: '34px', zIndex: 31 });
    c.cursor.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    // insertion line where the photo will land
    c.dropLine = el('div', 'abs', root); css(c.dropLine, { height: '6px', borderRadius: '3px', background: 'var(--sky)', boxShadow: '0 0 20px #5cb8ff', zIndex: 29 });
  },
  update(t, c) {
    const TM = c.TM;
    c.bg.update(t);
    titleIn(c.cap, t, 0.2);
    riseIn(c.win, t, 0.05, 0.8, 90);
    const caret = (active) => (active ? caretHtml(t) : '');
    // h1: before "# " completes it's a paragraph line with a dim marker
    const h1Done = t >= TM.h1.a + 2 / 30;
    c.h1.innerHTML = h1Done ? `<h1>${TM.h1.at(t)}${caret(t < TM.p.a)}</h1>` : `<p>${TM.h1.at(t)}${caret(t >= c.w0 - 0.3)}</p>`;
    c.p.innerHTML = t >= TM.p.a ? TM.p.at(t) + caret(t < TM.slash1 - TM.slashType) : '';
    // checklist item
    const a = TM.slash1 + 0.4, ty = TM.todo1, ck = TM.check1, d = c.todos[0];
    d.style.display = t >= a ? 'flex' : 'none';
    const on = t >= ck;
    d._box.className = 'box' + (on ? ' on' : '');
    d._box.innerHTML = on ? svgIcon('check', '#15120f', 3.5) : '';
    tf(d._box, { s: on ? lerp(1.4, 1, ep(t, ck, ck + 0.3, 'outBack')) : 1 });
    d._txt.className = on ? 'done' : '';
    d._txt.innerHTML = ty.at(t) + caret(t < ck && t >= a);
    // code block typing across tokens
    c.pre.style.display = t >= TM.codeA ? 'block' : 'none';
    let n = Math.floor((t - TM.codeA) * 58), html = '';
    c.code.forEach((line) => {
      for (const [cls, s] of line) { if (n <= 0) break; const part = s.slice(0, n); n -= part.length; html += `<span class="${cls}">${esc(part)}</span>`; }
    });
    c.pre.innerHTML = html + (t < TM.slash3 - TM.slashType ? caretHtml(t) : ''); // hands the caret to the next "/"
    // math: raw TeX, then rendered
    c.math.style.display = t >= TM.mathA ? 'flex' : 'none';
    if (t < TM.mathE) c.math.innerHTML = `<span class="mono" style="font-size:24px;color:var(--cream-3)">${esc(typed('$$' + c.tex + '$$', t, TM.mathA, 80))}</span>${caretHtml(t)}`;
    else { c.math.innerHTML = c.texHtml; tf(c.math.firstChild, { s: lerp(0.6, 1, ep(t, TM.mathE, TM.mathE + 0.4, 'outBack')) }); }
    // "/" typed on an empty line, shown until its block replaces it
    const opens = [TM.slash1 + 0.4, TM.codeA, TM.mathA];
    [TM.slash1, TM.slash2, TM.slash3].forEach((a, i) => {
      const l = c.slashLines[i], vis = t >= a - TM.slashType && t < opens[i];
      l.style.display = vis ? 'block' : 'none';
      if (vis) l.innerHTML = `<span class="mk">/</span>${caretHtml(t)}`;
    });
    // one media row: photo drops in, then audio and video slide in from the right while the
    // earlier blocks shrink and move left to make room
    const RW = 1360, GAP = 20;
    const ip = ep(t, TM.imgDrop, TM.imgDrop + 0.5, 'outBackSoft');
    const pa = ep(t, TM.aud, TM.aud + 0.55, 'inOutCubic'), pv = ep(t, TM.vid, TM.vid + 0.55, 'inOutCubic');
    const one = RW, two = (RW - GAP) / 2, three = (RW - 2 * GAP) / 3;
    const wPhoto = lerp(lerp(one, two, pa), three, pv), wAud = lerp(lerp(0, two, pa), three, pv), wVid = three * pv;
    css(c.row, { display: ip > 0 ? 'flex' : 'none', height: 190 * ip + 'px', gap: (pa > 0 ? GAP * Math.min(1, pa * 3) : 0) + 'px' });
    css(c.imgBox, { width: wPhoto + 'px', opacity: clamp(ip * 2) });
    css(c.aud, { width: wAud + 'px', display: pa > 0 ? 'flex' : 'none', opacity: clamp(pa * 2) });
    tf(c.aud, { x: (1 - pa) * 160 });
    css(c.vid, { width: wVid + 'px', display: pv > 0 ? 'block' : 'none', opacity: clamp(pv * 2) });
    tf(c.vid, { x: (1 - pv) * 160 });
    const ap = ((t - TM.aud) * 0.2) % 1;
    c.bars.forEach((b, i) => { b.style.background = i / c.bars.length < ap ? 'var(--gold-2)' : 'var(--cream-3)'; });
    css(c.vprog, { width: wVid * (((t - TM.vid) * 0.25) % 1) + 'px' });
    // slash menus
    const SM = c.SM;
    const menus = [[TM.slash1, 1], [TM.slash2, 2], [TM.slash3, 3]];
    let mShow = 0, mTarget = 0, mAt = 0;
    menus.forEach(([a, target]) => { const w = win(t, a + 0.05, a + SM, 0.12, 0.1); if (w > mShow) { mShow = w; mTarget = target; mAt = a; } });
    css(c.menu, { opacity: mShow, display: mShow > 0 ? 'block' : 'none' });
    const anchor = c.slashLines[mTarget - 1];
    if (mShow > 0 && anchor) {
      // just under the typed "/"; once the block replaces that line it sits where the "/" was, so the
      // same spot is its top + one text line (27 px x 1.55) and the menu never jumps while it fades
      const SLASH_LINE = 42;
      const top = anchor.offsetParent ? anchor.offsetTop : { 1: c.todos[0], 2: c.pre, 3: c.math }[mTarget].offsetTop;
      const y = top + SLASH_LINE + 30 + 10;
      css(c.menu, { left: '90px', top: Math.min(y, 560) + 'px' });
      tf(c.menu, { y: (1 - mShow) * 12, s: lerp(0.95, 1, mShow) });
      const hl = Math.min(mTarget, Math.floor(prog(t, mAt + 0.1, mAt + 0.4) * (mTarget + 1)));
      c.menuItems.forEach((it, i) => { it.style.background = i === hl ? '#f3a73b33' : 'transparent'; it.style.color = i === hl ? 'var(--gold-2)' : 'var(--cream)'; });
    }
    // drag a photo down from above the window; the block lands right under the math block
    const wrapTop = 150 + 46, dropTop = wrapTop + 30 + c.math.offsetTop + c.math.offsetHeight + 12;
    const tx = 210 + 70 + 380, ty2 = dropTop + 10;
    const dp = ep(t, TM.img, TM.imgDrop, 'inOutCubic');
    const dv = t >= TM.img - 0.2 && t < TM.imgDrop + 0.1;
    const dx = lerp(1500, tx, dp), dy = lerp(-220, ty2, dp);
    css(c.drag, { display: dv ? 'block' : 'none', left: dx + 'px', top: dy + 'px' });
    tf(c.drag, { r: lerp(-10, -2, dp), s: lerp(1.05, 0.92, dp), o: 1 - prog(t, TM.imgDrop - 0.05, TM.imgDrop + 0.1) });
    css(c.cursor, { display: dv ? 'block' : 'none', left: dx + 200 + 'px', top: dy + 120 + 'px' });
    const lw = win(t, TM.img + 0.6, TM.imgDrop + 0.05, 0.2, 0.1);
    css(c.dropLine, { display: lw > 0 ? 'block' : 'none', left: 280 + 'px', width: 1360 * lw + 'px', top: dropTop - 6 + 'px', opacity: lw });
    // footer
    const words = (c.doc.textContent.match(/\S+/g) || []).length;
    c.wc.textContent = T('editor.words', { n: words });
    c.saved.innerHTML = t > 1 ? `<span style="color:#8fb34a">✓</span> ${T('editor.saved')}` : '';
    // gentle scroll if the content outgrows the page
    const over = Math.max(0, c.doc.offsetHeight + 30 - c.docWrap.offsetHeight);
    tf(c.doc, { y: -over });
  },
});

scene('find', {
  enter: 'slide',
  build(root, c) {
    c.bg = blobs(root, ['#5cb8ff2a', '#45d6c822', '#f3a73b1a'], 66);
    c.cap = title(root, c.title, { y: 70, size: 80 });
    c.bar = el('div', 'panel abs flex', root); place(c.bar, 330, 300, 1000, 96); css(c.bar, { gap: '20px', padding: '0 34px', borderRadius: '24px' }); // bar + AI switch centred as one group
    icon('search', 36, c.bar, 'var(--cream-3)');
    c.q = el('div', '', c.bar); css(c.q, { fontSize: '36px', flex: 1 });
    // meaning-match badge (icon only), shown for the semantic query
    c.badge = el('div', 'ico', c.bar, svgIcon('sparkles', 'var(--gold-2)', 2.2));
    css(c.badge, { width: '54px', height: '54px', padding: '12px', borderRadius: '50%', background: '#f3a73b30', border: '1px solid #f3a73b88' });
    // AI switch next to the search bar: appears on "AI turned on", then flips on
    c.ai = el('div', 'panel abs flex', root); place(c.ai, 1360, 312, 230, 72);
    css(c.ai, { gap: '14px', padding: '0 20px', borderRadius: '22px', fontSize: '26px', fontWeight: 700, justifyContent: 'space-between' });
    c.aiLabel = el('span', 'flex', c.ai, `<span class="ico" style="width:28px;height:28px">${svgIcon('sparkles', '#c9b6ff', 2.2)}</span>${T('find.ai')}`); css(c.aiLabel, { gap: '10px' });
    c.aiTg = toggle(c.ai, 'var(--violet)');
    const R = (set, i) => [T(`find.${set}.${i}.h`), T(`find.${set}.${i}.b`), T(`find.${set}.${i}.d`)];
    const sets = [
      [T('find.q1'), [0, 1, 2].map(i => R('r1', i))],
      [null, [0, 1, 2].map(i => R('r2', i))],
    ];
    c.sets = sets.map(([word, res]) => ({ word, rows: res.map(([h, b, d], i) => {
      const r = el('div', 'panel-2 abs', root); place(r, 330, 450 + i * 150, 1000, 130); css(r, { padding: '22px 32px' });
      const hl = s => (word ? s.replace(new RegExp(`(${word})`, 'i'), '<mark style="background:#f3a73b55;color:#fff;border-radius:5px;padding:0 3px">$1</mark>') : s);
      const spark = word ? '' : `<span class="ico" style="width:22px;height:22px;margin-right:14px">${svgIcon('sparkles', 'var(--gold-2)', 2.2)}</span>`;
      r.innerHTML = `<div class="flex" style="justify-content:space-between"><div class="display" style="font-size:32px">${hl(h)}</div><div class="flex mono" style="font-size:18px;color:var(--cream-3)">${spark}${d}</div></div><div style="font-size:22px;color:var(--cream-2);margin-top:10px">${hl(b)}</div>`;
      return r;
    }) }));
  },
  update(t, c) {
    c.bg.update(t);
    const qc = (key, fb) => cueT(c, `find.cue.${key}`, 0, fb);
    titleIn(c.cap, t, 0.15);
    riseIn(c.bar, t, 0.1, 0.6, 40);
    // "Every word..." types "morning" → results on "written?" → the AI switch turns on at "AI turned on"
    // → backspace → the semantic query is typed on "search by meaning" with the sparkle badge
    const Q1 = T('find.q1'), Q2 = T('find.q2');
    const aQ1 = voAt(c) + 0.35, aRes1 = qc('written', 1.9) + 0.3;
    const aAi = qc('aiOn', 4.3), aAiOn = qc('turnedOn', 4.6) + 0.28, aBack = aAiOn + 0.2, aQ2 = qc('byMeaning', 6.0);
    const aRes2 = aQ2 + Q2.length / 24 * 0.75;
    let q;
    if (t < aBack) q = typed(Q1, t, aQ1, 10);
    else if (t < aQ2) q = Q1.slice(0, Math.max(0, Q1.length - Math.floor((t - aBack) * 14)));
    else q = typed(Q2, t, aQ2 + 0.05, 24);
    c.q.innerHTML = q + caretHtml(t);
    const ap = ep(t, aAi, aAi + 0.4, 'outBack');
    css(c.ai, { display: ap > 0 ? 'flex' : 'none' });
    tf(c.ai, { s: lerp(0.6, 1, ap), o: clamp(ap * 2), x: (1 - ap) * 40 });
    const on = ep(t, aAiOn, aAiOn + 0.3);
    setToggle(c.aiTg, on);
    c.ai.style.borderColor = on > 0.5 ? '#a58bffaa' : 'var(--line)';
    c.ai.style.boxShadow = `0 30px 80px #0008, 0 0 ${50 * on * (0.7 + 0.3 * Math.sin(t * 4))}px #a58bff66`;
    const bp = ep(t, aQ2, aQ2 + 0.45, 'outBack');
    css(c.badge, { display: bp > 0 ? 'flex' : 'none' });
    tf(c.badge, { s: lerp(0.3, 1, bp) * (1 + 0.06 * Math.sin(t * 4) * bp), o: clamp(bp * 2), r: lerp(-90, 0, bp) });
    const [A, B] = c.sets;
    const fadeA = aBack + 0.1;
    A.rows.forEach((r, i) => { r.style.display = t < fadeA + 0.6 ? 'block' : 'none'; riseIn(r, t, aRes1 + i * 0.15, 0.5, 40, { o: ep(t, aRes1 + i * 0.15, aRes1 + 0.5 + i * 0.15) * (1 - ep(t, fadeA + i * 0.06, fadeA + 0.4 + i * 0.06)) }); });
    B.rows.forEach((r, i) => { const vis = t > aRes2; r.style.display = vis ? 'block' : 'none'; if (vis) riseIn(r, t, aRes2 + 0.1 + i * 0.15, 0.5, 40); });
  },
});
