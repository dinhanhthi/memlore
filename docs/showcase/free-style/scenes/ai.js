// AI chapter: opt-in switch + four ways to run, twelve feature cards, the "second you", MCP.

scene('aiIntro', {
  enter: 'iris', enterOpts: { x: 960, y: 520 },
  build(root, c) {
    c.bg = blobs(root, ['#a58bff44', '#ff759733', '#5cb8ff22'], 101, '#120f18');
    c.cap = title(root, c.title, { y: 150, size: 100 });
    c.sw = el('div', 'abs flex', root); place(c.sw, 760, 360); css(c.sw, { gap: '30px', fontSize: '44px', fontWeight: 700 });
    el('span', '', c.sw, 'AI');
    c.tg = toggle(c.sw, 'var(--violet)'); css(c.tg, { transform: 'scale(2)', transformOrigin: 'left center', marginRight: '80px' });
    c.state = el('span', 'mono', c.sw); css(c.state, { fontSize: '28px', color: 'var(--cream-3)' });
    c.burst = Array.from({ length: 14 }, (_, i) => { const b = el('div', 'abs', root); place(b, 940, 380, 12, 12); css(b, { borderRadius: '50%', background: i % 2 ? '#ff7597' : '#c9b6ff' }); return { b, a: (i / 14) * Math.PI * 2 }; });
    c.ways = [['cpu', 'On-device'], ['server', 'Server'], ['terminal', 'CLI'], ['cloud', 'Cloud API']].map(([ic, n], i) => {
      const d = el('div', 'panel abs col', root); place(d, 130 + i * 425, 540, 390, 300); css(d, { alignItems: 'center', justifyContent: 'center', gap: '26px' });
      d.innerHTML = `<span style="width:130px;height:130px;border-radius:36px;padding:28px;background:#a58bff22;display:inline-block">${svgIcon(ic, '#c9b6ff', 2)}</span><div style="font-size:42px;font-weight:700">${n}</div>`;
      return d;
    });
  },
  update(t, c) {
    c.bg.update(t);
    const w = s => voAt(c) + s * (c.vo[0] ? c.vo[0].dur / 8.56 : 1 / 1.12); // raw word start (s) in the voice file -> scene time
    // the switch appears on "AI?" (raw 0.24) and flips on "turn it on" (3.12); the ways pop on "your device" (4.48),
    // "your own server" (5.52), "with any provider" (6.84 / 7.28)
    const TG = w(3.12) - 0.1, WAY = [w(4.48), w(5.52), w(6.84), w(7.28)];
    titleIn(c.cap, t, 0.2);
    riseIn(c.sw, t, w(0.24), 0.5, 30);
    const on = ep(t, TG, TG + 0.3);
    // until the voice says "turn it on" the knob nudges toward ON and falls back, so the still switch does not sit idle
    const tease = t > w(0.24) + 0.7 && t < TG ? 0.04 * (1 - ep(t, TG - 0.6, TG - 0.1)) * Math.max(0, Math.sin((t - w(0.24) - 0.7) * 5)) : 0;
    setToggle(c.tg, on + tease);
    c.state.textContent = on > 0.5 ? 'ON' : 'OFF';
    c.state.style.color = on > 0.5 ? 'var(--violet)' : 'var(--cream-3)';
    c.burst.forEach(({ b, a }) => { const p = prog(t, TG + 0.1, TG + 0.7); tf(b, { x: Math.cos(a) * 160 * Ease.outCubic(p), y: Math.sin(a) * 110 * Ease.outCubic(p), o: p > 0 && p < 1 ? 1 - p : 0 }); });
    c.ways.forEach((d, i) => {
      const a = WAY[i];
      d.style.opacity = t < a ? 0 : '';
      if (t >= a) popIn(d, t, a, 0.5, { y: (1 - ep(t, a, a + 0.5)) * 50 });
      const g = win(t, a, a + 1.4, 0.15, 0.6);
      d.style.boxShadow = `0 30px 80px #0008, 0 0 ${60 * g}px #a58bff88`;
      d.style.borderColor = g > 0.05 ? '#a58bffaa' : 'var(--line)';
    });
  },
});

// ── the twelve AI feature cards ──
const AI_CARDS = [
  { ic: 'type', name: 'Title generation', desc: 'A fitting title, from what you wrote.' },
  { ic: 'smile', name: 'Emotion suggestions', desc: 'Bad, neutral or good — it reads the mood.' },
  { ic: 'tag', name: 'Tag suggestions', desc: 'Tags that match your own vocabulary.' },
  { ic: 'highlighter', name: 'Entry highlights', desc: 'The lines worth remembering, pulled out.' },
  { ic: 'lightbulb', name: 'Go deeper prompts', desc: 'Gentle questions that open a page up.' },
  { ic: 'wand-sparkles', name: 'Continue & rewrite', desc: 'Keep going, or say it warmer.' },
  { ic: 'file-text', name: 'AI summaries', desc: 'Long entries, in three lines.' },
  { ic: 'search', name: 'Semantic search', desc: 'Search by meaning, not by keyword.' },
  { ic: 'message-circle', name: 'Daily Chat', desc: 'Talk your day through with an AI friend.' },
  { ic: 'image', name: 'Image generation', desc: 'Turn a memory into a picture.' },
  { ic: 'calendar-days', name: 'Period reviews', desc: 'Your week, month or year — in review.' },
  { ic: 'chart-column', name: 'Theme insights', desc: 'The threads running through your life.' },
];
const CARD_T = 3.5;
const SNIP = 'Got lost in Ribeira on purpose. The light at dusk was unreal. Found a tiny tasca with the best bacalhau in town, then sat by the river until the lamps came on.';
const LONG = SNIP + ' Walked the Dom Luís I bridge twice, once at noon and once at night. My legs hurt, and I did not care. Bought a small blue tile for the kitchen wall. Tomorrow: Livraria Lello, if the queue lets me.';
// card body: BW × BH, every child stays inside it
const BW = 840, BH = 540;

// "AI is working" effect: a shimmer sweep, twinkling sparkles and a closing flash over a
// rectangle of the card body. Build once per card with magicLayer(), drive with magic().
function magicLayer(body, seed) {
  const fx = el('div', 'abs', body); css(fx, { inset: 0, pointerEvents: 'none', zIndex: 6 });
  fx._clip = el('div', 'abs', fx); css(fx._clip, { overflow: 'hidden', borderRadius: '18px' });
  fx._sweep = el('div', 'abs', fx._clip); css(fx._sweep, { top: 0, bottom: 0, width: '300px', background: 'linear-gradient(100deg, transparent, #c9b6ff44 35%, #ffffffaa 50%, #ff97b544 65%, transparent)', mixBlendMode: 'screen', filter: 'blur(4px)' });
  fx._glow = el('div', 'abs', fx._clip); css(fx._glow, { inset: 0, background: 'radial-gradient(ellipse, #fff 0%, #c9b6ff99 35%, transparent 72%)', mixBlendMode: 'screen' });
  const r = rng(seed);
  fx._sp = Array.from({ length: 16 }, () => {
    const sz = 16 + r() * 24;
    const e = el('div', 'abs', fx, '✦'); css(e, { width: sz + 'px', height: sz + 'px', fontSize: sz + 'px', lineHeight: 1, textAlign: 'center', color: r() > 0.5 ? '#fff' : '#ffd6e2', textShadow: '0 0 10px #c9b6ff, 0 0 22px #a58bff' });
    return { e, sz, rx: r(), ry: r(), ph: r() };
  });
  return fx;
}
function magic(fx, u, a, d, R) {
  const on = u >= a - 0.05 && u <= a + d + 0.35;
  fx.style.display = on ? 'block' : 'none';
  if (!on) return;
  css(fx._clip, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px' });
  const p = prog(u, a, a + d);
  // two sweeps across the rectangle
  const sp = (p * 2) % 1;
  css(fx._sweep, { left: lerp(-300, R.w, Ease.inOutCubic(sp)) + 'px', opacity: p > 0 && p < 1 ? 1 : 0 });
  const flash = clamp(1 - Math.abs(u - (a + d)) / 0.28);
  fx._glow.style.opacity = flash * 0.85;
  fx._sp.forEach(({ e, sz, rx, ry, ph }) => {
    const x = clamp(R.x + rx * R.w - sz / 2, 0, BW - sz), y = clamp(R.y + ry * R.h - sz / 2, 0, BH - sz);
    const q = ((u - a) / 0.7 + ph) % 1;
    const tw = Math.sin(Math.PI * q) * ep(u, a, a + 0.2) * (1 - ep(u, a + d, a + d + 0.3));
    css(e, { left: x + 'px', top: y + 'px' });
    tf(e, { s: 0.3 + tw, r: q * 90, o: tw });
  });
}
// scan rectangle measured from the target element(s): offsetLeft/Top/Width/Height relative to the card body
function rectOf(...es) {
  const x = Math.min(...es.map(e => e.offsetLeft)), y = Math.min(...es.map(e => e.offsetTop));
  return { x, y, w: Math.max(...es.map(e => e.offsetLeft + e.offsetWidth)) - x, h: Math.max(...es.map(e => e.offsetTop + e.offsetHeight)) - y };
}
// text that materializes: blur → sharp while settling a few px, with a violet glow (no scale, so
// full-width blocks never poke past the card body)
function materialize(e, u, a, d = 0.5) {
  const p = ep(u, a, a + d, 'outCubic');
  e.style.opacity = clamp(p * 1.4);
  e.style.filter = `blur(${(1 - p) * 14}px) drop-shadow(0 0 ${24 * (1 - p) + 4}px #a58bff${p < 1 ? '99' : '55'})`;
  e.style.transform = `translateY(${(1 - p) * 14}px)`;
  return p;
}

function cardBody(i, body) {
  const P = (html, st = '') => { const d = el('div', '', body, html); css(d, { fontSize: '26px', lineHeight: 1.5, color: 'var(--cream-2)' }); if (st) d.style.cssText += st; return d; };
  const o = { fx: magicLayer(body, 300 + i) };
  switch (i) {
    case 0: // title generation
      o.field = el('div', 'abs', body); place(o.field, 0, 0, BW, 96); css(o.field, { borderRadius: '18px', border: '2px dashed var(--line-2)', padding: '12px 22px' });
      o.ph = el('div', 'display', o.field, 'Untitled'); css(o.ph, { fontSize: '54px', color: 'var(--ink-4)' });
      o.title = el('div', 'abs display grad-violet', o.field, 'Saturday in Porto'); css(o.title, { left: '22px', top: '12px', fontSize: '54px', transformOrigin: 'left center' });
      o.p = P(SNIP, 'position:absolute;left:0;top:140px;width:840px');
      o.btn = el('div', 'btn abs', body, `${svgIcon('sparkles', '#150d33', 2.4)}Suggest title`); css(o.btn, { right: '0', top: '440px', background: 'var(--violet)', color: '#150d33' }); o.btn.querySelector('svg').style.width = '24px';
      break;
    case 1: // emotion suggestions
      o.p = P(SNIP);
      o.faces = [['frown', 'Bad', '#ff7597'], ['meh', 'Neutral', '#f3a73b'], ['smile', 'Good', '#8fb34a']].map(([ic, l, col], k) => {
        const f = el('div', 'abs col', body); place(f, 15 + k * 295, 250, 220, 210); css(f, { alignItems: 'center', gap: '12px', borderRadius: '28px', border: '2px solid var(--line)', justifyContent: 'center', fontSize: '26px', fontWeight: 600 });
        f.innerHTML = `<span style="width:90px;height:90px;display:inline-block">${svgIcon(ic, col, 1.6)}</span>${l}`; f._col = col; return f; });
      break;
    case 2: // tag suggestions
      o.p = P(SNIP);
      o.chips = [['#travel', '#45d6c8'], ['#porto', '#ff7597'], ['#food', '#f3a73b'], ['#evening-walks', '#5cb8ff']].map(([s, col], k) => { const ch = el('div', 'chip abs', body, s); place(ch, (k % 2) * 420, 260 + Math.floor(k / 2) * 100); css(ch, { fontSize: '30px', background: col + '26', borderColor: col + '99', boxShadow: `0 0 24px ${col}33` }); return ch; });
      break;
    case 3: // entry highlights: a long entry becomes star points
      o.long = P(LONG, 'position:absolute;left:0;top:0;width:840px;font-size:24px;transform-origin:50% 0');
      o.items = ['The light at dusk was unreal.', 'Sat by the river until the lamps came on.', 'Walked the Dom Luís I bridge, twice.'].map((s, k) => {
        const it = el('div', 'abs flex', body, `<span style="width:34px;height:34px;display:inline-block;flex:none">${svgIcon('star', '#f3a73b', 2)}</span><span>${s}</span>`);
        place(it, 0, 70 + k * 120, BW); css(it, { gap: '18px', fontSize: '32px', fontFamily: 'var(--display)', padding: '18px 24px', borderRadius: '20px', background: '#f3a73b14', border: '1px solid #f3a73b44' }); return it; });
      break;
    case 4: // go deeper prompts
      o.p = P(SNIP, 'font-size:22px');
      o.qs = ['What made the light feel so unreal?', 'Who would you want to show Ribeira to?', 'What do you want to remember from today?'].map((q, k) => {
        const b = el('div', 'abs flex', body, `<span style="width:28px;height:28px;display:inline-block;flex:none">${svgIcon('lightbulb', '#ffcf7a', 2)}</span><span>${q}</span>`); place(b, (k % 2) * 100, 160 + k * 115); css(b, { gap: '14px', maxWidth: '740px', fontSize: '28px', padding: '16px 26px', borderRadius: '22px 22px 22px 6px', background: '#a58bff26', border: '1px solid #a58bff55', color: 'var(--cream)' }); return b; });
      break;
    case 5: // continue & rewrite
      o.p = el('div', 'abs', body); place(o.p, 0, 0, BW); css(o.p, { fontSize: '30px', lineHeight: 1.5, color: 'var(--cream-2)' });
      o.base = el('span', '', o.p, 'The light at dusk was unreal.');
      o.cont = el('span', '', o.p, ' And I promised myself I would come back in spring, with more time and less luggage.'); css(o.cont, { color: '#c9b6ff' });
      o.warm = el('div', 'abs', body, 'The golden light at dusk felt almost unreal, as if the whole city were glowing just for me. I promised myself I would come back in spring.'); place(o.warm, 0, 0, BW); css(o.warm, { fontSize: '30px', lineHeight: 1.5, color: '#ffc4d3' });
      o.b1 = el('div', 'chip abs', body, `${svgIcon('wand-sparkles', '#c9b6ff', 2)}<span>Continue writing</span>`); place(o.b1, 0, 440); css(o.b1, { background: '#a58bff22', borderColor: '#a58bff66' });
      o.b2 = el('div', 'chip abs', body, `${svgIcon('repeat', '#ff9db5', 2)}<span>Rewrite · warmer</span>`); place(o.b2, 360, 440); css(o.b2, { background: '#ff759722', borderColor: '#ff759766' });
      break;
    case 6: // AI summaries
      o.long = P(LONG, 'position:absolute;left:0;top:0;width:840px;font-size:24px;transform-origin:50% 0');
      o.sum = el('div', 'panel-2 abs', body); place(o.sum, 0, 40, BW); css(o.sum, { padding: '30px 34px', borderColor: '#a58bff66' });
      o.sum.innerHTML = ['A long, happy Saturday in Porto.', 'Wandered Ribeira and found a favourite tasca.', 'Ended by the river at dusk, wants to return.'].map(s => `<div class="ln" style="font-size:30px;margin-top:16px">• ${s}</div>`).join('');
      o.lines = [...o.sum.querySelectorAll('.ln')];
      break;
    case 7: // semantic search
      o.q = el('div', 'panel-2 flex abs', body); place(o.q, 0, 0, BW, 80); css(o.q, { gap: '16px', padding: '0 26px', fontSize: '30px' }); o.q.innerHTML = `<span style="width:32px;height:32px;display:inline-block">${svgIcon('search', 'var(--cream-3)', 2)}</span><span class="qq"></span>`;
      o.res = [['Quiet evening', 'Cooked dinner, read for an hour, early to bed.'], ['Tea on the balcony', 'Rain on the railing, nowhere to be.'], ['Lake at 6 AM', 'Mist, one heron, and no phone.']].map(([h, b], k) => {
        const r = el('div', 'panel-2 abs', body); place(r, 0, 120 + k * 140, BW); css(r, { padding: '18px 28px' });
        r.innerHTML = `<div class="flex" style="justify-content:space-between"><span class="display" style="font-size:32px">${h}</span></div><div style="font-size:23px;color:var(--cream-2);margin-top:6px">${b}</div>`; return r; });
      break;
    case 8: { // daily chat: two AI friends with different personalities, then the chat folds into an entry in your style
      const FR = [['sun', 'Sunny', 'Cheerful', '#f3a73b'], ['moon', 'Luna', 'Calm & thoughtful', '#a58bff']];
      const av = (f, sz) => `<span style="width:${sz}px;height:${sz}px;border-radius:50%;padding:${Math.round(sz * 0.22)}px;background:${f[3]}33;border:2px solid ${f[3]};display:inline-block;flex:none">${svgIcon(f[0], f[3], 2)}</span>`;
      o.friends = FR.map((f, k) => {
        const d = el('div', 'abs flex', body); place(d, 4 + k * 428, 0, 404, 92);
        css(d, { gap: '14px', padding: '0 18px', borderRadius: '24px', border: `2px solid ${f[3]}66`, background: f[3] + '14' });
        d.innerHTML = `${av(f, 60)}<div class="col" style="gap:6px;align-items:flex-start"><span style="font-size:28px;font-weight:700">${f[1]}</span><span class="pill tone" style="background:${f[3]}2e;color:${f[3]};font-size:16px;padding:4px 12px">${f[2]}</span></div>`;
        d._col = f[3]; d.tone = d.querySelector('.tone'); return d;
      });
      o.chat = el('div', 'abs col', body); place(o.chat, 4, 116, BW - 8); css(o.chat, { gap: '14px', transformOrigin: '50% 40%' });
      o.msgs = [[0, 'How did today feel?'], [-1, 'Tired, but the run helped.'], [1, 'Runs clear the head. What did you notice on the river?'], [0, 'Sounds like a day worth keeping! 🙂']].map(([who, s]) => {
        const f = FR[who], me = who < 0;
        const b = el('div', 'flex', o.chat); css(b, { alignSelf: me ? 'flex-end' : 'flex-start', gap: '12px', maxWidth: '680px', fontSize: '26px', lineHeight: 1.35, padding: '12px 22px 12px 14px', borderRadius: me ? '24px 24px 6px 24px' : '24px 24px 24px 6px', background: me ? 'var(--ink-4)' : f[3] + '22', border: `1px solid ${me ? 'var(--line-2)' : f[3] + '66'}`, color: 'var(--cream)', transformOrigin: me ? '100% 100%' : '0 100%' });
        b.innerHTML = (me ? '' : av(f, 38)) + `<span>${s}</span>`; if (me) b.style.paddingLeft = '22px';
        b._me = me; return b;
      });
      o.entry = el('div', 'panel-2 abs', body); place(o.entry, 4, 116, BW - 8); css(o.entry, { padding: '24px 32px', borderColor: '#a58bff66' });
      o.entry.innerHTML = `<div class="flex" style="justify-content:space-between"><span class="mono" style="font-size:18px;color:var(--cream-3)">DAILY CHAT · SEP 30</span><span class="pill stylep" style="background:#a58bff26;color:#c9b6ff;font-size:19px;padding:6px 16px"><span style="width:20px;height:20px;display:inline-block">${svgIcon('pen-line', '#c9b6ff', 2.2)}</span>Written in your style</span></div><div class="display" style="font-size:42px;margin-top:14px">A tired day, a good river</div><div style="font-size:26px;line-height:1.5;color:var(--cream-2);margin-top:10px">Tired today, but the run by the river helped more than I expected. The water was calm and the light came down soft. A day worth keeping.</div>`;
      o.stylep = o.entry.querySelector('.stylep');
      break; }
    case 9: // image generation
      o.prompt = el('div', 'panel-2 mono abs', body); place(o.prompt, 0, 0, BW, 70); css(o.prompt, { padding: '18px 24px', fontSize: '24px' });
      o.img = el('div', 'abs', body); place(o.img, 0, 100, BW, 380); css(o.img, { borderRadius: '20px', overflow: 'hidden', backgroundImage: 'url(../assets/photos/porto-003.jpg)', backgroundSize: 'cover', backgroundPosition: 'center' });
      o.bar = el('div', 'abs', body); place(o.bar, 0, 504, 0, 8); css(o.bar, { borderRadius: '4px', background: 'linear-gradient(90deg, var(--violet), var(--rose))' });
      break;
    case 10: // period reviews
      o.h = el('div', 'display', body, 'September in review'); css(o.h, { fontSize: '44px' });
      o.stats = [['entries', 28], ['words', 12200], ['day streak', 14]].map(([l, n], k) => { const s = el('div', 'abs', body); place(s, k * 290, 90, 260); s.innerHTML = `<div class="display n" style="font-size:64px;color:var(--gold-2)">0</div><div style="font-size:22px;color:var(--cream-3)">${l}</div>`; s._n = n; return s; });
      o.mood = el('div', 'abs', body); place(o.mood, 0, 280, BW, 26); css(o.mood, { borderRadius: '13px', overflow: 'hidden', display: 'flex', background: 'var(--ink-4)' });
      o.moodParts = [['#8fb34a', 65], ['#f3a73b', 20], ['#ff7597', 15]].map(([col, w]) => { const m = el('div', '', o.mood); css(m, { background: col, height: '100%' }); m._w = w; return m; });
      o.note = el('div', 'abs', body, '“You wrote most on Sunday evenings, and felt best after a run.”'); place(o.note, 0, 360, BW); css(o.note, { fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: '32px', color: 'var(--cream)' });
      break;
    case 11: // theme insights
      o.bubs = [['Work', 170, 150, 130, '#5cb8ff'], ['Health', 430, 130, 105, '#8fb34a'], ['Family', 680, 180, 125, '#ff7597'], ['Travel', 330, 330, 100, '#f3a73b'], ['Reading', 570, 360, 80, '#a58bff']].map(([n, x, y, r, col]) => {
        const b = el('div', 'abs col', body); place(b, x - r, y - r, r * 2, r * 2); css(b, { borderRadius: '50%', background: col + '33', border: `2px solid ${col}`, alignItems: 'center', justifyContent: 'center', fontSize: `${Math.max(20, r / 4.5)}px`, fontWeight: 700 }); b.textContent = n; return b; });
      o.note = el('div', 'abs', body, 'Work stress eases on weeks you hike.'); place(o.note, 0, 480, BW); css(o.note, { fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: '30px', textAlign: 'center' });
      break;
  }
  return o;
}

// u: card-local time, 0 → CARD_T (3.5 s). Rough shape: setup → action ~0.5 → magic → result ~2 → hold.
function cardUpdate(i, u, o, cu) {
  switch (i) {
    case 0: {
      o.btn.style.transform = `scale(${u > 0.5 && u < 0.65 ? 0.92 : 1})`;
      magic(o.fx, u, 0.65, 0.9, rectOf(o.field));
      const p = u < 1.5 ? 0 : materialize(o.title, u, 1.5, 0.55);
      if (u < 1.5) o.title.style.opacity = 0;
      o.ph.style.opacity = 1 - p;
      o.field.style.borderColor = p > 0 ? '#a58bff88' : 'var(--line-2)';
      o.field.style.boxShadow = `0 0 ${50 * win(u, 1.5, 2.6, 0.1, 0.8)}px #a58bff66`;
      break; }
    case 1: {
      const SEL = 2.0; // Good is chosen
      magic(o.fx, u, 0.4, 1.5, rectOf(o.p));
      o.faces.forEach((f, k) => {
        const hover = u < SEL && u > 0.5 && Math.floor(prog(u, 0.5, 1.9) * 3) === k;
        const sel = k === 2 && u >= SEL;
        const dim = k !== 2 && u >= SEL ? ep(u, SEL, SEL + 0.4) : 0;
        f.style.borderColor = sel ? f._col : hover ? 'var(--line-2)' : 'var(--line)';
        f.style.background = sel ? f._col + '2e' : hover ? 'var(--ink-3)' : 'transparent';
        f.style.boxShadow = sel ? `0 0 ${40 * (0.6 + 0.4 * Math.sin(u * 5))}px ${f._col}66` : 'none';
        f.style.filter = dim ? `grayscale(${dim}) brightness(${1 - 0.35 * dim})` : 'none';
        tf(f, { s: sel ? lerp(1.12, 1.07, ep(u, SEL, SEL + 0.4, 'outBack')) : lerp(1, 0.84, dim), o: 1 - 0.55 * dim });
      });
      break; }
    case 2:
      magic(o.fx, u, 0.3, 1.0, rectOf(o.p));
      o.chips.forEach((ch, k) => { const a = 1.3 + k * 0.3; ch.style.opacity = u < a ? 0 : ''; if (u >= a) materialize(ch, u, a, 0.4); });
      break;
    case 3: {
      // sweep the whole long entry, then it dissolves into star points
      magic(o.fx, u, 0.5, 1.2, rectOf(o.long));
      const k = ep(u, 1.7, 2.2, 'inOutCubic');
      o.long.style.opacity = 1 - k; o.long.style.filter = `blur(${k * 10}px)`; o.long.style.transform = `scaleY(${1 - 0.5 * k})`;
      o.items.forEach((it, j) => { const a = 2.0 + j * 0.28; it.style.opacity = u < a ? 0 : ''; if (u >= a) materialize(it, u, a, 0.45); });
      break; }
    case 4:
      magic(o.fx, u, 0.3, 0.9, rectOf(o.p));
      o.p.style.opacity = lerp(1, 0.55, ep(u, 1.0, 1.4));
      o.qs.forEach((q, k) => { const a = 1.2 + k * 0.5; q.style.opacity = u < a ? 0 : ''; if (u >= a) materialize(q, u, a, 0.45); });
      break;
    case 5: {
      // continue (0.3 press → magic → new words glow in), then rewrite warmer (1.8 press → magic → morph)
      o.b1.style.transform = `scale(${u > 0.3 && u < 0.45 ? 0.92 : 1})`;
      o.b2.style.transform = `scale(${u > 1.8 && u < 1.95 ? 0.92 : 1})`;
      o.b1.style.boxShadow = u > 0.3 && u < 1.5 ? '0 0 30px #a58bff66' : 'none';
      o.b2.style.boxShadow = u > 1.8 ? '0 0 30px #ff759766' : 'none';
      if (u < 1.7) magic(o.fx, u, 0.45, 0.6, rectOf(o.p)); else magic(o.fx, u, 1.95, 0.6, rectOf(o.p));
      if (u < 1.05) o.cont.style.opacity = 0; else materialize(o.cont, u, 1.05, 0.45);
      const m = ep(u, 2.45, 2.85, 'inOutCubic');
      o.p.style.opacity = 1 - m; o.p.style.filter = `blur(${m * 12}px)`;
      o.warm.style.opacity = m; o.warm.style.filter = `blur(${(1 - m) * 12}px)`;
      popIn(o.b1, u, 0.05, 0.3); popIn(o.b2, u, 1.5, 0.3);
      break; }
    case 6: {
      magic(o.fx, u, 0.5, 1.1, rectOf(o.long));
      const k = ep(u, 1.5, 2.0, 'inOutCubic');
      o.long.style.opacity = 1 - k; o.long.style.filter = `blur(${k * 10}px)`; o.long.style.transform = `scaleY(${1 - 0.7 * k})`;
      o.sum.style.opacity = u < 1.8 ? 0 : 1;
      if (u >= 1.8) materialize(o.sum, u, 1.8, 0.4);
      o.lines.forEach((l, j) => riseIn(l, u, 2.0 + j * 0.2, 0.4, 16));
      break; }
    case 7:
      o.q.querySelector('.qq').innerHTML = typed('when did I feel at peace?', u, 0.1, 26) + caretHtml(u, u < 1.1);
      magic(o.fx, u, 1.1, 0.6, rectOf(o.q));
      o.res.forEach((r, k) => { const a = 1.75 + k * 0.3; r.style.opacity = u < a ? 0 : ''; if (u >= a) materialize(r, u, a, 0.4); });
      break;
    case 8: {
      // cu = cue times (card-local): friends named on "AI friends", tones on "personality", the chat folds into an entry on "turn those chats", the style chip on "written in your own style"
      const FOLD = cu.turn + 0.15, ENT = FOLD + 0.85, MSG = [1.0, 1.9, 2.6, 3.6];
      o.friends.forEach((f, k) => {
        const a = 0.3 + k * 0.35;
        f.style.opacity = u < a ? 0 : ''; if (u >= a) popIn(f, u, a, 0.4);
        const g = win(u, cu.friends + k * 0.3, cu.friends + k * 0.3 + 1.2, 0.15, 0.6);
        f.style.boxShadow = `0 0 ${40 * g}px ${f._col}77`;
        const ta = cu.pers + k * 0.35; f.tone.style.opacity = u < ta ? 0 : ''; if (u >= ta) popIn(f.tone, u, ta, 0.3);
        f.style.filter = u > FOLD ? `opacity(${lerp(1, 0.55, ep(u, FOLD, FOLD + 0.5))})` : 'none';
      });
      o.msgs.forEach((m, k) => { m.style.opacity = u < MSG[k] ? 0 : ''; if (u >= MSG[k]) { if (m._me) popIn(m, u, MSG[k], 0.4); else materialize(m, u, MSG[k], 0.4); } });
      const f = ep(u, FOLD + 0.1, FOLD + 0.9, 'inCubic');
      o.chat.style.opacity = u < FOLD ? '' : 1 - f;
      o.chat.style.filter = `blur(${f * 12}px)`;
      o.chat.style.transform = `scale(${1 - 0.45 * f}) translateY(${-30 * f}px)`;
      o.chat.style.display = f >= 1 ? 'none' : 'flex';
      magic(o.fx, u, cu.turn, 0.85, rectOf(o.chat));
      o.entry.style.display = u < ENT ? 'none' : 'block';
      if (u >= ENT) materialize(o.entry, u, ENT, 0.5);
      const sa = Math.max(cu.style - 0.5, ENT + 0.2);
      o.stylep.style.opacity = u < sa ? 0 : ''; if (u >= sa) popIn(o.stylep, u, sa, 0.4);
      o.entry.style.boxShadow = `0 0 ${50 * win(u, cu.style - 0.2, cu.style + 1.2, 0.1, 0.8)}px #a58bff88`;
      break; }
    case 9: {
      o.prompt.innerHTML = '✨ ' + typed('watercolour of Porto at dusk', u, 0.05, 36);
      const g = ep(u, 0.9, 2.3, 'outCubic');
      css(o.img, { filter: `blur(${lerp(40, 0, g)}px) saturate(${lerp(0.2, 1.4, g)}) contrast(${lerp(0.6, 1.05, g)}) hue-rotate(${lerp(90, 0, g)}deg)`, opacity: ep(u, 0.8, 1.0) });
      magic(o.fx, u, 0.9, 1.4, rectOf(o.img));
      o.bar.style.width = BW * ep(u, 0.9, 2.3, 'linear') + 'px';
      o.bar.style.opacity = 1 - ep(u, 2.4, 2.7);
      break; }
    case 10:
      magic(o.fx, u, 0.2, 0.7, rectOf(...o.stats));
      o.stats.forEach((s, k) => { s.querySelector('.n').textContent = countUp(u, 0.8 + k * 0.15, 1.9 + k * 0.15, s._n).toLocaleString('en-US'); riseIn(s, u, 0.7 + k * 0.12, 0.4, 20); });
      o.moodParts.forEach(m => { m.style.width = m._w * ep(u, 1.3, 2.0) + '%'; });
      o.note.style.opacity = u < 2.2 ? 0 : ''; if (u >= 2.2) materialize(o.note, u, 2.2, 0.5);
      break;
    case 11:
      magic(o.fx, u, 0.2, 0.8, rectOf(...o.bubs));
      o.bubs.forEach((b, k) => popIn(b, u, 0.9 + k * 0.22, 0.5, { y: bob(u, k, 5) }));
      o.note.style.opacity = u < 2.2 ? 0 : ''; if (u >= 2.2) materialize(o.note, u, 2.2, 0.5);
      break;
  }
}

scene('aiCards', {
  enter: 'slide',
  build(root, c) {
    c.bg = blobs(root, ['#a58bff3a', '#ff75972a', '#5cb8ff22'], 111, '#120f18');
    c.name = el('div', 'abs display', root); place(c.name, 110, 330, 620); css(c.name, { fontSize: '88px' });
    // tray of 12 icons
    c.tray = AI_CARDS.map((k, i) => { const s = el('div', 'abs', root); place(s, 110 + (i % 6) * 100, 800 + Math.floor(i / 6) * 100, 80, 80); css(s, { borderRadius: '22px', padding: '20px', border: '1px solid var(--line)', background: 'var(--ink-2)' }); s.innerHTML = svgIcon(k.ic, 'currentColor', 2); return s; });
    c.cards = AI_CARDS.map((k, i) => {
      const card = el('div', 'panel abs', root); place(card, 820, 170, 940, 700);
      css(card, { borderRadius: '34px', background: 'linear-gradient(160deg, #221d2b, #191620)', borderColor: '#a58bff44' });
      const head = el('div', 'abs flex', card); place(head, 44, 36); css(head, { gap: '14px', fontSize: '22px', color: 'var(--cream-3)', fontWeight: 600 });
      head.innerHTML = `<span style="width:40px;height:40px;border-radius:12px;padding:8px;background:#a58bff26;display:inline-block">${svgIcon(k.ic, '#c9b6ff', 2.2)}</span>${k.name}<span class="pill" style="background:#a58bff26;color:#c9b6ff;font-size:15px">AI</span>`;
      const body = el('div', 'abs', card); css(body, { left: '50px', right: '50px', top: '120px', bottom: '40px', overflow: 'hidden' });
      return { card, body, o: cardBody(i, body) };
    });
    // finale grid
    c.grid = AI_CARDS.map((k, i) => {
      const g = el('div', 'panel abs flex', root); place(g, 150 + (i % 4) * 415, 250 + Math.floor(i / 4) * 200, 385, 170);
      css(g, { gap: '20px', padding: '0 30px', borderRadius: '26px', borderColor: '#a58bff44' });
      g.innerHTML = `<span style="width:64px;height:64px;border-radius:18px;padding:14px;background:#a58bff26;display:inline-block;flex:none">${svgIcon(k.ic, '#c9b6ff', 2)}</span><span style="font-size:28px;font-weight:700">${k.name}</span>`;
      return g;
    });
    c.gridTitle = title(root, c.title, { y: 110, size: 84 });
  },
  update(t, c) {
    c.bg.update(t);
    const N = AI_CARDS.length;
    // card i starts its action on its voice-over line (vo[i].at); the closing line "All optional. All yours." (vo[12]) brings the grid
    const A = i => voAt(c, i, 0.3 + i * CARD_T), end = A(N), LEAD = 0.3;
    const U8 = p => cue(c, p, 8, A(8)) - A(8) + LEAD; // card-local time of a word in the Daily Chat line
    const cues8 = { friends: U8('AI friends'), pers: U8('personality'), turn: U8('turn those chats'), style: U8('written in your own style') };
    const idx = AI_CARDS.reduce((m, _, i) => (t >= A(i) - 0.05 ? i : m), 0);
    const fin = ep(t, end - 0.1, end + 0.5, 'inOutCubic');
    const k = AI_CARDS[idx];
    // left rail swaps the big feature name on each card
    const lt = t - A(idx);
    c.name.textContent = k.name;
    tf(c.name, { x: (1 - ep(lt, -0.1, 0.3)) * -40, o: ep(lt, -0.1, 0.3) * (1 - fin) });
    c.tray.forEach((s, i) => {
      const done = i < idx || (t >= end), act = i === idx && t < end;
      s.style.color = act ? '#15120f' : done ? '#c9b6ff' : 'var(--cream-3)';
      s.style.background = act ? 'var(--violet)' : done ? '#a58bff22' : 'var(--ink-2)';
      tf(s, { s: act ? 1.12 : 1, o: 1 - fin });
    });
    c.cards.forEach(({ card, o }, i) => {
      const a = A(i);
      const inP = ep(t, a - 0.45, a + 0.05, 'outCubic');
      const outP = i === N - 1 ? fin : ep(t, A(i + 1) - 0.45, A(i + 1) + 0.05, 'inCubic');
      const vis = inP > 0 && outP < 1;
      card.style.display = vis ? 'block' : 'none';
      if (!vis) return;
      tf(card, { x: (1 - inP) * 500 - outP * 380, y: (1 - inP) * 40 + bob(t, i, 4), r: (1 - inP) * 6 - outP * 5, s: lerp(0.9, 1, inP) * lerp(1, 0.8, outP), o: inP * (1 - outP) });
      cardUpdate(i, t - a + LEAD, o, i === 8 ? cues8 : null);
    });
    titleIn(c.gridTitle, t, end);
    c.gridTitle.style.display = t > end ? 'block' : 'none';
    c.grid.forEach((g, i) => { g.style.display = t > end ? 'flex' : 'none'; popIn(g, t, end + 0.15 + i * 0.15, 0.4); });
  },
});

scene('secondYou', {
  enter: 'zoom',
  build(root, c) {
    c.bg = blobs(root, ['#a58bff44', '#f3a73b2a', '#ff759722'], 121, '#110e16');
    c.cap = title(root, c.title, { y: 70, size: 92 });
    // column A: entries
    c.entries = ['Sunday again — quick weekly review before bed.', 'Green tea first, then the laptop. Always.', 'Big presentation tomorrow. Stomach in knots.'].map((s, i) => {
      const e = el('div', 'panel-2 abs', root); place(e, 90, 290 + i * 170, 420, 140); css(e, { padding: '20px 24px' });
      e.innerHTML = `<div class="mono" style="font-size:16px;color:var(--cream-3)">ENTRY · SEP ${20 - i * 6}</div><div style="font-size:24px;margin-top:8px">${s}</div>`;
      return e;
    });
    // column B: memories
    c.memPanel = el('div', 'panel abs', root); place(c.memPanel, 600, 290, 620, 480); css(c.memPanel, { padding: '28px 30px', background: 'linear-gradient(160deg, #a58bff40, #a58bff14), var(--ink-2)', borderColor: '#a58bff77' });
    c.memPanel.innerHTML = `<div class="flex" style="gap:12px;font-size:26px;font-weight:700"><span style="width:32px;height:32px;display:inline-block">${svgIcon('brain', '#c9b6ff', 2)}</span>Memories</div>`;
    c.mems = ['Prefers Sunday evenings for a weekly review.', 'Drinks green tea every morning.', 'Gets nervous before big presentations.', 'Likes hiking in the mountains.', 'Wants to go back to Đà Nẵng.'].map((s, i) => {
      const m = el('div', 'flex', c.memPanel); css(m, { gap: '12px', marginTop: i ? '12px' : '22px', padding: '14px 18px', borderRadius: '14px', background: '#a58bff1c', border: '1px solid #a58bff44', fontSize: '22px' });
      m.innerHTML = `<span style="flex:1">${s}</span><span style="width:22px;height:22px;display:inline-block;opacity:.6">${svgIcon('x', 'var(--cream-3)', 2)}</span>`;
      return m;
    });
    // column C: persona
    c.pers = el('div', 'panel abs', root); place(c.pers, 1310, 290, 520, 480); css(c.pers, { padding: '28px 30px', background: 'linear-gradient(160deg, #f3a73b40, #f3a73b14), var(--ink-2)', borderColor: '#f3a73b77' });
    c.pers.innerHTML = `<div class="flex" style="gap:12px;font-size:26px;font-weight:700"><span style="width:32px;height:32px;display:inline-block">${svgIcon('user-round', '#f3a73b', 2)}</span>Your persona</div>`;
    c.sliders = [['Warm', 'Direct', 0.25], ['Brief', 'Detailed', 0.3], ['Serious', 'Playful', 0.7]].map(([a, b, v]) => {
      const s = el('div', '', c.pers); css(s, { marginTop: '26px' });
      s.innerHTML = `<div class="flex" style="justify-content:space-between;font-size:19px;color:var(--cream-3)"><span>${a}</span><span>${b}</span></div>`;
      const tr = el('div', '', s); css(tr, { height: '8px', borderRadius: '4px', background: 'var(--ink-4)', marginTop: '10px', position: 'relative' });
      const kn = el('div', 'abs', tr); css(kn, { top: '-9px', width: '26px', height: '26px', borderRadius: '50%', background: 'var(--gold)', boxShadow: '0 0 0 5px #f3a73b33' });
      return { kn, v };
    });
    c.persText = el('div', '', c.pers); css(c.persText, { marginTop: '30px', fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: '25px', lineHeight: 1.4, color: 'var(--cream)' });
    // phase B: you + second you
    c.you = el('div', 'abs col', root); place(c.you, 420, 330, 380, 440); css(c.you, { alignItems: 'center', gap: '10px' });
    c.you.innerHTML = '<img src="../assets/logo-straight.png" style="width:320px;filter:drop-shadow(0 30px 40px #000a)"><div class="display" style="font-size:40px">You</div>';
    c.two = el('div', 'abs col', root); place(c.two, 1120, 330, 380, 440); css(c.two, { alignItems: 'center', gap: '10px' });
    c.two.innerHTML = '<div style="position:relative;width:320px;height:320px"><img src="../assets/logo-straight.png" style="width:320px;filter:hue-rotate(215deg) saturate(1.4) brightness(1.1) drop-shadow(0 0 40px #a58bffaa)"><div class="scan" style="position:absolute;inset:0;background:repeating-linear-gradient(0deg,#a58bff22 0 3px,transparent 3px 9px);mix-blend-mode:screen;border-radius:40%"></div></div><div class="display grad-violet" style="font-size:40px">Second you</div>';
    c.orbit = ['Sunday reviews', 'Green tea', 'Presentation nerves', 'Mountain hikes', 'Đà Nẵng'].map((s, i) => {
      const d = el('div', 'chip abs', root, s); place(d, 0, 0); css(d, { fontSize: '21px', padding: '8px 16px', background: '#a58bff26', borderColor: '#a58bff77', zIndex: 3 });
      const a = -2.5 + i * 1.25; d._tx = 1310 + Math.cos(a) * 290 - 80; d._ty = 500 + Math.sin(a) * 230; return d; });
    c.bubble = el('div', 'abs', root, 'Sunday evening — time for your weekly review? Green tea first 🍵'); place(c.bubble, 1480, 170, 400);
    css(c.bubble, { fontSize: '28px', padding: '20px 28px', borderRadius: '26px 26px 26px 6px', background: 'var(--ink-3)', border: '1px solid #a58bff66' });
  },
  update(t, c) {
    c.bg.update(t);
    const w = s => voAt(c) + s * (c.vo[0] ? c.vo[0].dur / 7.36 : 1 / 1.12); // raw word start (s) in the voice file -> scene time
    // entries + memories on "Memlore can remember" (raw 0 / 0.72), the persona on "and even learn" (2.56), its sliders on "learn" (3.16)
    // and text on "write" (3.56); "every memory?" (5.56) blends to you + second you, memories fly over, the bubble lands on "edit" (6.56)
    const PER = w(2.56), BL = w(5.56), T2 = w(6.08), BUB = w(6.56) + 0.4;
    titleIn(c.cap, t, 0.2);
    const B = ep(t, BL, BL + 0.6, 'inOutCubic'); // phase B blend
    c.entries.forEach((e, i) => riseIn(e, t, w(0) + i * 0.12, 0.5, 40, { o: ep(t, w(0) + i * 0.12, w(0) + 0.5 + i * 0.12) * (1 - B), x: -B * 200 }));
    riseIn(c.memPanel, t, w(0.72), 0.6, 50, { o: ep(t, w(0.72), w(0.72) + 0.5) * (1 - B), s: 1 - 0.2 * B });
    c.mems.forEach((m, i) => { const a = w(0.72) + 0.4 + i * 0.35; const p = ep(t, a, a + 0.45, 'outBack'); tf(m, { x: (1 - p) * -260, o: clamp(p * 1.5), s: lerp(0.8, 1, p) }); });
    riseIn(c.pers, t, PER, 0.6, 50, { o: ep(t, PER, PER + 0.5) * (1 - B), x: B * 200 });
    c.sliders.forEach(({ kn, v }, i) => { const a = w(3.16) + i * 0.2; kn.style.left = `calc(${lerp(50, v * 100, ep(t, a, a + 0.6, 'outBack'))}% - 13px)`; });
    c.persText.innerHTML = typed('“Writes short, warm sentences. Loves slow mornings, mountains and Đà Nẵng.”', t, w(3.56), 60);
    // phase B
    const showB = t > BL - 0.1;
    c.you.style.display = c.two.style.display = showB ? 'flex' : 'none';
    riseIn(c.you, t, BL + 0.1, 0.6, 60);
    popIn(c.two, t, T2, 0.6);
    const scan = c.two.querySelector('.scan'); if (scan) scan.style.backgroundPosition = `0 ${(t * 40) % 9}px`;
    c.orbit.forEach((d, i) => {
      const q = Ease.inOutCubic(prog(t, T2 + 0.1 + i * 0.18, T2 + 1.1 + i * 0.18));
      const x = lerp(560, d._tx, q), y = lerp(500, d._ty, q) - Math.sin(q * Math.PI) * 160 + (q >= 1 ? bob(t, i, 6) : 0);
      css(d, { left: x + 'px', top: y + 'px', display: t > T2 + 0.1 + i * 0.18 ? 'inline-flex' : 'none' });
      tf(d, { s: lerp(0.6, 1, q), o: clamp(q * 3) });
    });
    popIn(c.bubble, t, BUB, 0.5);
    c.bubble.style.display = t > BUB - 0.1 ? 'block' : 'none';
  },
});

scene('mcp', {
  enter: 'wipe',
  build(root, c) {
    c.bg = blobs(root, ['#45d6c82a', '#a58bff22'], 131);
    c.cap = title(root, c.title, { y: 70, size: 84 });
    // left: a generic AI-agent chat (dark neutral chrome, no brand mark); right: Memlore
    const a = macWindow(root, 110, 260, 720, 560, '');
    c.left = a.win; css(a.win, { background: '#212121', borderColor: '#ffffff26' });
    a.win.querySelector('.title').innerHTML = `<span class="flex" style="gap:10px;color:#ececec;font-weight:600;font-size:19px"><span style="width:26px;height:26px;display:inline-block">${svgIcon('sparkles', '#ececec', 2)}</span>Your AI agent</span>`;
    const conn = el('div', 'abs pill', a.win, `${svgIcon('plug', '#8ff0e6', 2.2)}Memlore connected`); css(conn, { right: '16px', top: '8px', background: '#45d6c81f', color: '#8ff0e6', fontSize: '15px' }); conn.querySelector('svg').style.width = '16px';
    c.greet = el('div', 'abs flex', a.body); place(c.greet, 40, 26, 620); css(c.greet, { gap: '14px', fontSize: '24px', color: '#ececec' });
    c.greet.innerHTML = `<span style="width:38px;height:38px;border-radius:50%;border:1px solid #ffffff33;padding:7px;display:inline-block;flex:none">${svgIcon('sparkles', '#ececec', 2)}</span><span>Hi! What shall we do today?</span>`;
    c.user = el('div', 'abs', a.body, 'Add to my journal: 5 km along the river this morning, felt great.'); place(c.user, 190, 84, 490);
    css(c.user, { fontSize: '24px', padding: '16px 22px', borderRadius: '24px', background: '#303030', color: '#ececec' });
    c.tools = ['search_entries', 'append_to_entry'].map((n, i) => {
      const tl = el('div', 'abs flex mono', a.body); place(tl, 40, 200 + i * 62, 600); css(tl, { gap: '14px', fontSize: '20px', padding: '10px 18px', borderRadius: '14px', background: '#2a2a2a', border: '1px solid #ffffff1a', color: '#cfcfcf' });
      tl.innerHTML = `<span class="st" style="width:24px;height:24px;display:inline-block"></span><span style="color:#9b9b9b">Called</span><span style="color:#8ff0e6">memlore</span><span style="color:#9b9b9b">·</span><span>${n}</span>`;
      return tl;
    });
    c.reply = el('div', 'abs flex', a.body); place(c.reply, 40, 338, 620); css(c.reply, { gap: '16px', alignItems: 'flex-start', fontSize: '24px', color: '#ececec', lineHeight: 1.45 });
    c.reply.innerHTML = `<span style="width:38px;height:38px;border-radius:50%;border:1px solid #ffffff33;padding:7px;display:inline-block;flex:none">${svgIcon('sparkles', '#ececec', 2)}</span><span>Done. I appended it to your entry “Morning run along the river”.</span>`;
    const inp = el('div', 'abs flex', a.body); place(inp, 40, 440, 640, 60); css(inp, { borderRadius: '30px', background: '#303030', padding: '0 24px', fontSize: '21px', color: '#8f8f8f', justifyContent: 'space-between' });
    inp.innerHTML = `<span>Ask anything</span><span style="width:34px;height:34px;border-radius:50%;background:#ececec;padding:8px;display:inline-block">${svgIcon('send', '#212121', 2.4)}</span>`;
    // wire
    c.wire = el('div', 'abs', root); place(c.wire, 840, 538, 240, 6); css(c.wire, { borderRadius: '3px', background: 'repeating-linear-gradient(90deg, #45d6c8 0 14px, transparent 14px 24px)' });
    c.plug = el('div', 'abs col', root); place(c.plug, 890, 440, 140, 90); css(c.plug, { alignItems: 'center', gap: '6px', fontSize: '18px', color: '#8ff0e6', fontFamily: 'var(--mono)' });
    c.plug.innerHTML = `<span style="width:40px;height:40px;display:inline-block">${svgIcon('plug', '#45d6c8', 2)}</span>localhost`;
    const b = macWindow(root, 1090, 260, 720, 560, '');
    b.win.querySelector('.title').innerHTML = '<span class="flex" style="gap:10px;color:var(--cream);font-weight:600;font-size:19px"><img src="../assets/logo.png" style="width:30px;height:30px">Memlore</span>';
    c.right = b.win;
    el('div', 'mono', b.body, 'DAILY JOURNAL · 07:12').style.cssText = 'position:absolute;left:44px;top:36px;font-size:18px;color:var(--cream-3)';
    el('div', 'display', b.body, 'Morning run along the river').style.cssText = 'position:absolute;left:44px;top:70px;font-size:44px';
    el('div', '', b.body, 'Five kilometres before breakfast. Legs heavy at first, then found a rhythm.').style.cssText = 'position:absolute;left:44px;top:150px;width:620px;font-size:25px;color:var(--cream-2);line-height:1.5';
    c.app = el('div', 'abs', b.body, '+ 5 km along the river this morning, felt great.'); place(c.app, 44, 260, 620);
    css(c.app, { fontSize: '25px', padding: '14px 18px', borderRadius: '12px', background: '#8fb34a26', borderLeft: '4px solid #8fb34a', color: '#dff0b8' });
    // v2 badges
    c.badges = el('div', 'abs flex', root); place(c.badges, 0, 880, 1920); css(c.badges, { justifyContent: 'center', gap: '28px' });
    c.badge = [['wifi-off', 'Local only'], ['eye-off', 'Off by default'], ['cloud-off', 'No AI provider required']].map(([ic, n]) => {
      const p = el('div', 'pill', c.badges, `<span style="width:30px;height:30px;display:inline-block">${svgIcon(ic, '#8ff0e6', 2)}</span>${n}`);
      css(p, { fontSize: '28px', padding: '12px 28px', gap: '12px', background: 'var(--ink-3)', border: '1px solid #45d6c866', color: 'var(--cream)' }); return p; });
    c.pulse = el('div', 'abs', root); place(c.pulse, 0, 530, 22, 22); css(c.pulse, { borderRadius: '50%', background: '#fff', boxShadow: '0 0 20px 6px #45d6c8' });
  },
  update(t, c) {
    c.bg.update(t);
    // agent window on "Already" (0.7), Memlore + the plug/wire on "Connect", the request on "journal right from the chat",
    // the tool calls on "right", the note lands in the app on "chat" and the reply follows on "All locally"; the badges close on "on your own machine"
    const CON = cue(c, 'Connect', 0, 2.7), REQ = cue(c, 'journal', 0, 6.7), TOOL = cue(c, 'right', 0, 7.2), APP = cue(c, 'chat', 0, 7.95), REP = cue(c, 'All locally', 0, 8.3);
    const BAD = cue(c, 'locally', 0, 8.5) + 0.3;
    titleIn(c.cap, t, 0.2);
    riseIn(c.left, t, voAt(c), 0.6, 60); popIn(c.greet, t, cue(c, 'agent', 0, 1.8), 0.4); riseIn(c.right, t, CON - 0.4, 0.6, 60);
    popIn(c.user, t, REQ, 0.4);
    c.tools.forEach((tl, i) => {
      const a = TOOL + i * 0.5;
      popIn(tl, t, a, 0.35);
      const done = t > a + 0.55;
      tl.querySelector('.st').innerHTML = done ? svgIcon('check', '#8fb34a', 3) : svgIcon('refresh-cw', '#45d6c8', 2.4);
      tl.querySelector('.st').style.transform = done ? '' : `rotate(${t * 400}deg)`;
    });
    c.wire.style.backgroundPosition = `${t * 60}px 0`;
    popIn(c.plug, t, CON, 0.4);
    c.wire.style.opacity = ep(t, CON, CON + 0.4);
    const pp = prog(t, TOOL + 0.2, APP);
    css(c.pulse, { left: lerp(840, 1070, (pp * 2) % 1) + 'px', opacity: pp > 0 && pp < 1 ? 1 : 0 });
    const ap = ep(t, APP, APP + 0.4, 'outBack');
    tf(c.app, { s: lerp(0.8, 1, ap), o: clamp(ap * 2) });
    c.app.style.boxShadow = `0 0 ${40 * (1 - prog(t, APP, APP + 1))}px #8fb34a88`;
    popIn(c.reply, t, REP, 0.4);
    c.badge.forEach((p, i) => { p.style.opacity = t < BAD + i * 0.35 ? 0 : ''; popIn(p, t, BAD + i * 0.35, 0.4); });
  },
});
