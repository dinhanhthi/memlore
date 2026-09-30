// Opening: glowing dots assemble the low-poly logo, the dog looks around, wordmark, then the tagline and
// kicker; then a kinetic hook.

scene('intro', {
  build(root, c) {
    c.bg = blobs(root, ['#f3a73b55', '#a58bff44', '#ff759733', '#f3a73b33'], 11);
    // glowing golden dots of mixed size and opacity converging into the head
    const r = rng(42);
    const shardLayer = el('div', 'abs', root); css(shardLayer, { inset: 0 });
    const tones = ['#e0a15a', '#c98a45', '#f0bd7a', '#b87a3a', '#d99a52', '#f6cf93', '#ffd79a'];
    c.shards = Array.from({ length: 110 }, (_, i) => {
      const s = el('div', 'abs', shardLayer);
      const size = 10 + Math.pow(r(), 1.6) * 70;
      const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * 200;
      const tx = 960 + Math.cos(a) * rad * 0.9 - size / 2, ty = 470 + Math.sin(a) * rad - size / 2;
      const tone = tones[i % tones.length];
      css(s, { width: size + 'px', height: size + 'px', left: tx + 'px', top: ty + 'px', borderRadius: '50%', background: `radial-gradient(circle at 35% 35%, #fff6 0%, ${tone} 45%, ${tone} 100%)`,
        boxShadow: `0 0 ${size * 0.6}px ${size * 0.15}px ${tone}99, 0 ${size * 0.15}px ${size * 0.4}px #0006`, opacity: 0 });
      const fa = r() * Math.PI * 2, fd = 900 + r() * 700;
      return { s, fx: Math.cos(fa) * fd, fy: Math.sin(fa) * fd, fr: 0, d: r() * 0.7, alpha: 0.35 + r() * 0.65 };
    });
    c.ring = el('div', 'abs', root);
    css(c.ring, { left: '960px', top: '470px', width: '10px', height: '10px', borderRadius: '50%', border: '6px solid #ffd79a', opacity: 0 });
    // logo frames (same framing): default (looks right), straight, blink
    c.logo = el('div', 'abs', root);
    place(c.logo, 960 - 230, 470 - 230, 460, 460);
    c.frames = {};
    for (const [k, src] of Object.entries({ def: 'logo.png', straight: 'logo-straight.png', blink: 'logo-blink.png' })) {
      const im = el('img', 'abs', c.logo); im.src = `../assets/${src}`;
      css(im, { inset: 0, width: '100%', height: '100%', filter: 'drop-shadow(0 30px 50px #0009)' });
      c.frames[k] = im;
    }
    c.word = el('div', 'abs display', root);
    css(c.word, { left: 0, right: 0, top: '600px', textAlign: 'center', fontSize: '190px', fontWeight: 600 });
    c.letters = (c.title || 'Memlore').split('').map(ch => { const s = el('span', '', c.word, ch); css(s, { display: 'inline-block' }); return s; });
    // three glowing tokens on the spoken words "a thought" / "a feeling" / "a moment" (Lucide: lightbulb, heart, image);
    // same look as the logo shards (radial gradient, soft glow); they leave together on the wordmark cue
    c.tokens = [['lightbulb', '#f3a73b', 'a thought', 3.14], ['heart', '#ff7597', 'a feeling', 3.96], ['image', '#a58bff', 'a moment', 5.0]].map(([ic, tone, phrase, fb], i) => {
      const s = el('div', 'abs', root);
      const sz = 160;
      css(s, { width: sz + 'px', height: sz + 'px', left: 960 + (i - 1) * 300 - sz / 2 + 'px', top: 775 - sz / 2 + 'px', borderRadius: '50%', padding: '38px', boxSizing: 'border-box', opacity: 0,
        background: `radial-gradient(circle at 35% 35%, #fff6 0%, ${tone} 45%, ${tone} 100%)`, boxShadow: `0 0 ${sz * 0.45}px ${sz * 0.12}px ${tone}99, 0 ${sz * 0.1}px ${sz * 0.3}px #0006` });
      s.innerHTML = svgIcon(ic, '#fff', 2.2);
      return { s, phrase, fb, i };
    });
    // v2 tagline + kicker line; they rise right after the wordmark (not spoken here, the outro says the tagline)
    c.tag = el('div', 'abs display ital', root, 'A little life. <span class="grad-gold">A lasting story.</span>');
    css(c.tag, { left: 0, right: 0, top: '830px', textAlign: 'center', fontSize: '58px', fontWeight: 400, color: 'var(--cream-2)' });
    c.sub = el('div', 'abs kicker', root, 'The private journal · local-first · AI when you want it');
    css(c.sub, { left: 0, right: 0, top: '935px', textAlign: 'center', fontSize: '20px', color: 'var(--cream-3)' });
    // sparkles
    const r2 = rng(9);
    c.sparks = Array.from({ length: 26 }, () => {
      const s = el('div', 'abs', root);
      const sz = 4 + r2() * 8;
      css(s, { width: sz + 'px', height: sz + 'px', borderRadius: '50%', background: r2() > 0.5 ? '#ffd79a' : '#c9b6ff', left: (r2() * W) + 'px', top: (r2() * H) + 'px', boxShadow: '0 0 12px currentColor' });
      return { s, ph: r2() * 6, sp: 0.4 + r2() };
    });
  },
  update(t, c) {
    c.bg.update(t);
    // shards fly in 0.1 → 1.7
    c.shards.forEach(({ s, fx, fy, fr, d, alpha }) => {
      const p = ep(t, 0.1 + d, 1.35 + d * 0.5, 'outExpo');
      const fade = 1 - ep(t, 1.7, 2.1);
      tf(s, { x: fx * (1 - p), y: fy * (1 - p), r: fr * (1 - p), s: lerp(2.2, 1, p), o: clamp(p * 2) * fade * alpha });
    });
    // shockwave + logo reveal at 1.9
    const rp = prog(t, 1.85, 2.6);
    const rr = 20 + Ease.outCubic(rp) * 900;
    css(c.ring, { opacity: rp > 0 && rp < 1 ? (1 - rp) : 0, width: rr * 2 + 'px', height: rr * 2 + 'px', left: 960 - rr + 'px', top: 470 - rr + 'px', borderWidth: lerp(14, 2, rp) + 'px' });
    const lp = ep(t, 1.75, 2.3, 'outBack');
    // the logo floats while the voice talks, then lifts and shrinks so the wordmark lands on "Memlore"
    const M = Math.max(2.6, cue(c, 'Memlore', 0));
    const up = ep(t, M - 0.3, M + 0.4, 'inOutCubic');
    tf(c.logo, { s: lerp(0.7, 1, lp) * lerp(1, 0.62, up), y: lerp(0, -170, up) + bob(t, 0, 6), o: clamp(lp * 1.5) });
    // look: default → straight (2.3), then a blink every 2.6 s for the rest of the scene
    const f = t < 2.3 ? 'def' : t > 3 && (t - 3) % 2.6 < 0.15 ? 'blink' : 'straight';
    for (const k in c.frames) c.frames[k].style.opacity = k === f ? 1 : 0;
    c.letters.forEach((s, i) => { const p = ep(t, M + i * 0.07, M + 0.65 + i * 0.07, 'outBack'); tf(s, { y: (1 - p) * 120, o: clamp(p * 1.4), r: (1 - p) * -8 }); });
    tf(c.word, { s: 1 + 0.05 * clamp((t - M - 0.7) / Math.max(1, c.dur - M - 0.7)) }); // slow push-in so the end never freezes
    // tokens pop in on their words, bob, then shrink + fade together just before the wordmark letters land
    const out = ep(t, M - 0.35, M, 'inCubic');
    c.tokens.forEach(({ s, phrase, fb, i }) => {
      const a = cue(c, phrase, 0, fb);
      const p = prog(t, a, a + 0.45);
      if (p <= 0 || t >= M + 0.4 || out >= 1) { s.style.opacity = 0; return; }
      tf(s, { s: lerp(0.5, 1, Ease.outBack(p)) * (1 - 0.6 * out), y: bob(t, i * 1.3, 8), o: Ease.outCubic(p) * (1 - out) });
    });
    riseIn(c.tag, t, M + 1.1, 0.7, 30);
    riseIn(c.sub, t, M + 1.7, 0.6, 20);
    c.sparks.forEach(({ s, ph, sp }) => tf(s, { y: -((t * 40 * sp) % 200), o: clamp(ep(t, 1.9, 2.6)) * (0.35 + 0.45 * Math.sin(t * 3 * sp + ph)) }));
  },
});

scene('hook', {
  enter: 'iris', enterOpts: { x: 960, y: 300 },
  build(root, c) {
    c.bg = el('div', 'abs', root); css(c.bg, { inset: 0 });
    const words = (c.title || 'Write. Remember. Reflect. Privately.').split(' ');
    c.items = [
      [words[0], '#f3a73b', '#2a1a05', 'write-with-icon'],
      [words[1], '#a58bff', '#1b1238', 'read'],
      [words[2], '#45d6c8', '#062724', 'ai'],
      [words[3], '#15120f', '#f5eee4', 'privacy'],
    ].map(([w, bg, fg, st], i) => {
      const layer = el('div', 'abs', root); css(layer, { inset: 0, background: bg });
      const word = el('div', 'abs display', layer, w); css(word, { left: 0, right: 0, top: '380px', textAlign: 'center', fontSize: '250px', color: fg });
      const sk = sticker(layer, st, i % 2 ? 1380 : 180, 620, 360);
      return { layer, word, sk, i };
    });
    const last = c.items[3];
    last.word.classList.add('grad-gold');
    last.word.style.color = 'transparent';
  },
  update(t, c) {
    c.items.forEach(({ layer, word, sk, i }) => {
      const a = voAt(c, i, [0.1, 0.964, 1.9, 3.121][i]); // each word lands on its voice-over line
      const show = t >= a;
      layer.style.display = show ? 'block' : 'none';
      if (!show) return;
      // each layer wipes in from the bottom-right corner
      const p = ep(t, a, a + 0.32, 'outCubic');
      layer.style.clipPath = i === 0 ? '' : `circle(${p * 2300}px at ${i % 2 ? 1500 : 400}px 900px)`;
      const wp = ep(t, a + 0.02, a + 0.45, 'outBack');
      tf(word, { s: lerp(1.5, 1, wp), o: clamp(wp * 2), blur: (1 - wp) * 16, y: i === 3 ? -40 * ep(t, a + 0.4, a + 1) : 0 });
      const sp = popIn(sk, t, a + 0.18, 0.5, { r: i % 2 ? 8 : -8, y: bob(t, i) });
      if (sp <= 0) sk.style.opacity = 0;
    });
  },
});
