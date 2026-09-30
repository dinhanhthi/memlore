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
    const { win, body } = macWindow(root, 210, 150, 1500, 900, 'Saturday in Porto');
    c.win = win;
    c.docWrap = el('div', 'abs', body); css(c.docWrap, { left: 0, right: 0, top: 0, bottom: '64px', overflow: 'hidden' });
    c.doc = el('div', 'doc abs', c.docWrap); css(c.doc, { left: '70px', right: '70px', top: '30px' });
    const foot = el('div', 'abs flex', body); css(foot, { left: 0, right: 0, bottom: 0, height: '64px', borderTop: '1px solid var(--line)', padding: '0 30px', justifyContent: 'space-between', fontSize: '20px', color: 'var(--cream-3)', fontFamily: 'var(--mono)' });
    c.wc = el('span', '', foot); c.saved = el('span', '', foot);

    // ── schedule ── each markdown shortcut and block lands on its spoken word (lib.js cue())
    const q = (phrase, fb) => cue(c, phrase, 0, fb);
    c.w0 = voAt(c);
    const T = {};
    const SM = 0.6; // slash menu on screen
    T.h1 = typer([MK('# ', ''), { raw: 'Saturday in Porto', html: 'Saturday in Porto' }], q('Headings', 2.3) - 0.3, 30);
    T.p = typer(['The light was ', MK('==unreal==', '<mark>unreal</mark>'), ' in ', { ...MK('[Ribeira](https://…)', '<a>Ribeira</a>'), pause: 0.3 }, '.'], T.h1.end + 0.05, 70);
    T.slash1 = Math.max(T.p.end + 0.35, q('checklists', 4.2) - 0.1); // "/" → checklist, once the paragraph is typed
    T.todo1 = typer(['Pastel de nata'], T.slash1 + 0.4, 40);
    T.check1 = T.todo1.end + 0.15;
    T.slash2 = Math.max(T.check1 + 0.35, q('code', 4.9) - 0.1); // code, once the checklist item is done
    const code = [[['tk-k', 'const '], ['tk-p', 'km = days.'], ['tk-f', 'map'], ['tk-p', '(d => d.walked)']]];
    T.codeA = T.slash2 + 0.5; T.codeLen = code.flat().reduce((n, [, s]) => n + s.length, 0); T.codeE = T.codeA + T.codeLen / 58;
    T.slash3 = Math.max(T.codeE + 0.35, q('even math', 5.9) - 0.1); // math
    const tex = '\\sum_{d=1}^{3} \\text{km}_d = 42.2';
    T.mathA = T.slash3 + 0.5; T.mathE = T.mathA + ('$$' + tex + '$$').length / 80;
    T.imgDrop = q('photos', 8.4); // photos: drag in from the top, drop on "photos"
    T.img = T.imgDrop - 1.1;
    T.aud = q('audio', 9.2); T.vid = q('video', 10.1); // then audio and video join the same row
    T.slashType = 0.3; // the "/" is typed this long before its menu opens
    c.T = T; c.code = code; c.tex = tex; c.SM = SM;
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
    const capn = el('div', 'abs', c.imgBox, 'Dusk over the Douro'); css(capn, { left: '18px', bottom: '14px', fontSize: '20px', padding: '6px 14px', borderRadius: '10px', background: '#0009' });
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
    c.menuItems = [['heading', 'Heading'], ['list-checks', 'Checklist'], ['code', 'Code block'], ['sigma', 'Math block'], ['image', 'Image'], ['table', 'Table']].map(([ic, l]) => {
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
    const T = c.T;
    c.bg.update(t);
    titleIn(c.cap, t, 0.2);
    riseIn(c.win, t, 0.05, 0.8, 90);
    const caret = (active) => (active ? caretHtml(t) : '');
    // h1: before "# " completes it's a paragraph line with a dim marker
    const h1Done = t >= T.h1.a + 2 / 30;
    c.h1.innerHTML = h1Done ? `<h1>${T.h1.at(t)}${caret(t < T.p.a)}</h1>` : `<p>${T.h1.at(t)}${caret(t >= c.w0 - 0.3)}</p>`;
    c.p.innerHTML = t >= T.p.a ? T.p.at(t) + caret(t < T.p.end) : '';
    // checklist item
    const a = T.slash1 + 0.4, ty = T.todo1, ck = T.check1, d = c.todos[0];
    d.style.display = t >= a ? 'flex' : 'none';
    const on = t >= ck;
    d._box.className = 'box' + (on ? ' on' : '');
    d._box.innerHTML = on ? svgIcon('check', '#15120f', 3.5) : '';
    tf(d._box, { s: on ? lerp(1.4, 1, ep(t, ck, ck + 0.3, 'outBack')) : 1 });
    d._txt.className = on ? 'done' : '';
    d._txt.innerHTML = ty.at(t) + caret(t < ck && t >= a);
    // code block typing across tokens
    c.pre.style.display = t >= T.codeA ? 'block' : 'none';
    let n = Math.floor((t - T.codeA) * 58), html = '';
    c.code.forEach((line) => {
      for (const [cls, s] of line) { if (n <= 0) break; const part = s.slice(0, n); n -= part.length; html += `<span class="${cls}">${esc(part)}</span>`; }
    });
    c.pre.innerHTML = html + (t < T.slash3 - T.slashType ? caretHtml(t) : ''); // hands the caret to the next "/"
    // math: raw TeX, then rendered
    c.math.style.display = t >= T.mathA ? 'flex' : 'none';
    if (t < T.mathE) c.math.innerHTML = `<span class="mono" style="font-size:24px;color:var(--cream-3)">${esc(typed('$$' + c.tex + '$$', t, T.mathA, 80))}</span>${caretHtml(t)}`;
    else { c.math.innerHTML = c.texHtml; tf(c.math.firstChild, { s: lerp(0.6, 1, ep(t, T.mathE, T.mathE + 0.4, 'outBack')) }); }
    // "/" typed on an empty line, shown until its block replaces it
    const opens = [T.slash1 + 0.4, T.codeA, T.mathA];
    [T.slash1, T.slash2, T.slash3].forEach((a, i) => {
      const l = c.slashLines[i], vis = t >= a - T.slashType && t < opens[i];
      l.style.display = vis ? 'block' : 'none';
      if (vis) l.innerHTML = `<span class="mk">/</span>${caretHtml(t)}`;
    });
    // one media row: photo drops in, then audio and video slide in from the right while the
    // earlier blocks shrink and move left to make room
    const RW = 1360, GAP = 20;
    const ip = ep(t, T.imgDrop, T.imgDrop + 0.5, 'outBackSoft');
    const pa = ep(t, T.aud, T.aud + 0.55, 'inOutCubic'), pv = ep(t, T.vid, T.vid + 0.55, 'inOutCubic');
    const one = RW, two = (RW - GAP) / 2, three = (RW - 2 * GAP) / 3;
    const wPhoto = lerp(lerp(one, two, pa), three, pv), wAud = lerp(lerp(0, two, pa), three, pv), wVid = three * pv;
    css(c.row, { display: ip > 0 ? 'flex' : 'none', height: 190 * ip + 'px', gap: (pa > 0 ? GAP * Math.min(1, pa * 3) : 0) + 'px' });
    css(c.imgBox, { width: wPhoto + 'px', opacity: clamp(ip * 2) });
    css(c.aud, { width: wAud + 'px', display: pa > 0 ? 'flex' : 'none', opacity: clamp(pa * 2) });
    tf(c.aud, { x: (1 - pa) * 160 });
    css(c.vid, { width: wVid + 'px', display: pv > 0 ? 'block' : 'none', opacity: clamp(pv * 2) });
    tf(c.vid, { x: (1 - pv) * 160 });
    const ap = ((t - T.aud) * 0.2) % 1;
    c.bars.forEach((b, i) => { b.style.background = i / c.bars.length < ap ? 'var(--gold-2)' : 'var(--cream-3)'; });
    css(c.vprog, { width: wVid * (((t - T.vid) * 0.25) % 1) + 'px' });
    // slash menus
    const SM = c.SM;
    const menus = [[T.slash1, 1], [T.slash2, 2], [T.slash3, 3]];
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
    const dp = ep(t, T.img, T.imgDrop, 'inOutCubic');
    const dv = t >= T.img - 0.2 && t < T.imgDrop + 0.1;
    const dx = lerp(1500, tx, dp), dy = lerp(-220, ty2, dp);
    css(c.drag, { display: dv ? 'block' : 'none', left: dx + 'px', top: dy + 'px' });
    tf(c.drag, { r: lerp(-10, -2, dp), s: lerp(1.05, 0.92, dp), o: 1 - prog(t, T.imgDrop - 0.05, T.imgDrop + 0.1) });
    css(c.cursor, { display: dv ? 'block' : 'none', left: dx + 200 + 'px', top: dy + 120 + 'px' });
    const lw = win(t, T.img + 0.6, T.imgDrop + 0.05, 0.2, 0.1);
    css(c.dropLine, { display: lw > 0 ? 'block' : 'none', left: 280 + 'px', width: 1360 * lw + 'px', top: dropTop - 6 + 'px', opacity: lw });
    // footer
    const words = (c.doc.textContent.match(/\S+/g) || []).length;
    c.wc.textContent = `${words} words`;
    c.saved.innerHTML = t > 1 ? '<span style="color:#8fb34a">✓</span> Saved' : '';
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
    c.aiLabel = el('span', 'flex', c.ai, `<span class="ico" style="width:28px;height:28px">${svgIcon('sparkles', '#c9b6ff', 2.2)}</span>AI`); css(c.aiLabel, { gap: '10px' });
    c.aiTg = toggle(c.ai, 'var(--violet)');
    const sets = [
      ['morning', [['A fresh start', 'Woke up early and felt genuinely optimistic about the week ahead, one slow morning at a time…', 'Mon, Sep 28'],
        ['Morning run along the river', 'Five kilometres before breakfast. Legs heavy at first…', 'Mon, Sep 28'],
        ['Rough morning', 'Alarm did not go off and I missed my standup…', 'Thu, Sep 24']]],
      [null, [['Sketching by the water', 'Drew the boats on the river while the rain passed. Nothing to fix, nowhere to be…', 'Sun, Aug 30'],
        ['Saturday in Porto', 'Sat by the river until the lamps came on over the Douro…', 'Sat, Sep 19'],
        ['Slow Sunday', 'No plans, a long bath, and the quiet that comes after a hard week…', 'Sun, Sep 13']]],
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
    const qc = (phrase, fb) => cue(c, phrase, 0, fb);
    titleIn(c.cap, t, 0.15);
    riseIn(c.bar, t, 0.1, 0.6, 40);
    // "Every word..." types "morning" → results on "written?" → the AI switch turns on at "AI turned on"
    // → backspace → the semantic query is typed on "search by meaning" with the sparkle badge
    const Q1 = 'morning', Q2 = 'when did I feel calm?';
    const aQ1 = voAt(c) + 0.35, aRes1 = qc('written', 1.9) + 0.3;
    const aAi = qc('AI turned on', 4.3), aAiOn = qc('turned on', 4.6) + 0.28, aBack = aAiOn + 0.2, aQ2 = qc('search by meaning', 6.0);
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
